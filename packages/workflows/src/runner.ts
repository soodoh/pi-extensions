import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { loadWorkflowConfig } from "./config-loader";
import { applyModelPolicy } from "./model-policy";
import { reviewPlanWithPlannotator } from "./plannotator";
import { getRun, saveRun, withRunLock } from "./store";
import { truncateWorkflowText } from "./text-limits";
import {
	ensureInsideCwd,
	ensureRealPathInsideCwd,
	extensionDir,
	makeRunId,
	normalizeWorkflowRunId,
	nowIso,
	sha256,
} from "./utils";
import type {
	LoadedConfig,
	WorkflowCommand,
	WorkflowDefinition,
	WorkflowNode,
	WorkflowRunRecord,
} from "./workflow-types";

type MaybePromise<T> = T | Promise<T>;

type ExistingPlanArtifact = {
	planPath: string;
	planContent: string;
	planContentHash: string;
};

const MAX_PLAN_MARKDOWN_BYTES = 1024 * 1024;

async function relativeToRealCwd(
	cwd: string,
	fullPath: string,
): Promise<string> {
	return relative(await realpath(cwd), fullPath);
}

function planPathValidationMessage(filePath: string): string {
	return `Plan must be an existing markdown file inside workflow cwd: ${filePath}`;
}

async function resolveExistingPlanMarkdownPath(
	cwd: string,
	filePath: string,
): Promise<string> {
	const lexicalFull = ensureInsideCwd(cwd, filePath);
	if (!existsSync(lexicalFull) || !/\.mdx?$/i.test(lexicalFull)) {
		throw new Error(planPathValidationMessage(filePath));
	}
	const realFull = await ensureRealPathInsideCwd(cwd, filePath);
	if (!/\.mdx?$/i.test(realFull)) {
		throw new Error(planPathValidationMessage(filePath));
	}
	return realFull;
}

function assertPlanContentWithinLimit(content: string, label: string): void {
	const size = Buffer.byteLength(content, "utf8");
	if (size > MAX_PLAN_MARKDOWN_BYTES) {
		throw new Error(
			`Plan markdown is too large (${size} bytes; max ${MAX_PLAN_MARKDOWN_BYTES} bytes): ${label}`,
		);
	}
}

async function readBoundedPlanMarkdown(
	fullPath: string,
	label: string,
): Promise<string> {
	const metadata = await stat(fullPath);
	if (!metadata.isFile()) throw new Error(planPathValidationMessage(label));
	if (metadata.size > MAX_PLAN_MARKDOWN_BYTES) {
		throw new Error(
			`Plan markdown file is too large (${metadata.size} bytes; max ${MAX_PLAN_MARKDOWN_BYTES} bytes): ${label}`,
		);
	}
	return readFile(fullPath, "utf8");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type WorkflowSessionManager = {
	getSessionFile?: () => string | undefined;
	appendSessionInfo?: (name: string) => void;
	appendMessage?: (message: {
		role: "user";
		content: Array<{ type: "text"; text: string }>;
		timestamp: number;
	}) => void;
};

export type WorkflowContext = {
	cwd: string;
	sessionManager?: WorkflowSessionManager;
	newSession(options: {
		parentSession?: string;
		setup?: (sessionManager: WorkflowSessionManager) => MaybePromise<void>;
		withSession: (ctx: WorkflowContext) => MaybePromise<void>;
	}): Promise<{ cancelled: boolean }>;
	sendUserMessage(message: string): Promise<void>;
	modelRegistry?: Parameters<typeof applyModelPolicy>[1]["modelRegistry"];
};

type WorkflowPiApi = Parameters<typeof applyModelPolicy>[0] & {
	events: import("./pi-events").EventsLike;
	appendEntry?: (type: string, entry: Record<string, unknown>) => void;
	sendUserMessage?: (
		message: string,
		options?: { deliverAs?: string },
	) => void | Promise<void>;
};

export class WorkflowRunner {
	private readonly continueExecutionLocks = new Map<string, Promise<void>>();
	private pi: WorkflowPiApi;
	private importMetaUrl: string;
	constructor(pi: WorkflowPiApi, importMetaUrl: string) {
		this.pi = pi;
		this.importMetaUrl = importMetaUrl;
	}
	private root(): string {
		return extensionDir(this.importMetaUrl);
	}
	async config(cwd: string): Promise<LoadedConfig> {
		return await loadWorkflowConfig(cwd, this.root());
	}
	async findWorkflow(
		cwd: string,
		name: string,
	): Promise<WorkflowDefinition | undefined> {
		return (await this.config(cwd)).workflows.find((w) => w.name === name);
	}
	async findCommand(
		cwd: string,
		name: string,
	): Promise<WorkflowCommand | undefined> {
		return (await this.config(cwd)).commands.find((c) => c.name === name);
	}
	async list(cwd: string): Promise<string> {
		const config = await this.config(cwd);
		const workflows =
			config.workflows
				.map(
					(w) =>
						`- ${w.name}: ${firstLine(w.description)} (${short(cwd, w.sourcePath)})`,
				)
				.join("\n") || "(none)";
		const diagnostics = config.diagnostics.length
			? `\n\nDiagnostics:\n${config.diagnostics.map((d) => `- ${d}`).join("\n")}`
			: "";
		return `Workflows:\n${workflows}${diagnostics}`;
	}
	async startWorkflow(
		name: string,
		args: string,
		ctx: WorkflowContext,
	): Promise<WorkflowRunRecord> {
		const workflow = await this.findWorkflow(ctx.cwd, name);
		if (!workflow) throw new Error(`Unknown workflow: ${name}`);
		const existingPlan =
			name === "execute-plan"
				? await this.loadExistingPlanArtifact(ctx.cwd, args)
				: undefined;
		const run: WorkflowRunRecord = {
			id: makeRunId(),
			workflowName: name,
			phase: "created",
			cwd: ctx.cwd,
			createdAt: nowIso(),
			updatedAt: nowIso(),
			request: args,
			logs: [`${nowIso()} created workflow ${name}`],
		};
		await saveRun(run);
		this.pi.appendEntry?.("pi-workflow-run", {
			runId: run.id,
			workflowName: name,
			phase: run.phase,
		});

		if (existingPlan) return this.startExistingPlan(run, existingPlan, ctx);
		return this.startPlanning(run, workflow, args, ctx);
	}
	private async startPlanning(
		run: WorkflowRunRecord,
		workflow: WorkflowDefinition,
		args: string,
		ctx: WorkflowContext,
	): Promise<WorkflowRunRecord> {
		const planNode = workflow.nodes.find(
			(n) => n.id === "create-plan" && n.command,
		);
		if (!planNode?.command)
			throw new Error(`${workflow.name} is missing create-plan command node`);
		const command = await this.findCommand(ctx.cwd, planNode.command);
		if (!command) throw new Error(`Missing command: ${planNode.command}`);
		const prompt = this.renderCommand(command, {
			ARGUMENTS: args,
			USER_MESSAGE: args,
			WORKFLOW_ID: run.id,
			ARTIFACTS_DIR: this.artifactsDir(ctx.cwd, run.id),
		});
		const modelPolicy =
			workflow.modelPolicy?.planning ?? workflow.modelPolicy?.default;
		const selection = await applyModelPolicy(
			this.pi,
			ctx,
			modelPolicy,
			"planning",
		);
		run.logs.push(selection.reason);
		await saveRun(run);
		const sessionName = `workflow: ${run.workflowName} planning ${run.id}`;
		let planningSessionPath: string | undefined;
		try {
			const sessionResult = await ctx.newSession({
				parentSession: ctx.sessionManager?.getSessionFile?.(),
				setup: async (sm) => {
					sm.appendSessionInfo?.(sessionName);
				},
				withSession: async (newCtx) => {
					planningSessionPath = newCtx.sessionManager
						?.getSessionFile?.()
						?.trim();
					if (!planningSessionPath) {
						throw new Error(
							`Workflow run ${run.id} planning session did not provide a session file; refusing to mark the run planning.`,
						);
					}
					await newCtx.sendUserMessage(prompt);
				},
			});
			if (sessionResult.cancelled) {
				throw new Error(
					`Workflow run ${run.id} planning session was cancelled.`,
				);
			}
			if (!planningSessionPath) {
				throw new Error(
					`Workflow run ${run.id} planning session did not provide a session file; refusing to mark the run planning.`,
				);
			}
		} catch (err) {
			run.phase = "created";
			run.planningSessionPath = undefined;
			await saveRun(run);
			throw err;
		}
		run.phase = "planning";
		run.planningSessionPath = planningSessionPath;
		run.logs.push(`${nowIso()} planning session started`);
		await saveRun(run);
		return run;
	}
	private async loadExistingPlanArtifact(
		cwd: string,
		args: string,
	): Promise<ExistingPlanArtifact> {
		const planPath = args.trim();
		const full = await resolveExistingPlanMarkdownPath(cwd, planPath);
		const planContent = await readBoundedPlanMarkdown(full, planPath);
		return {
			planPath: await relativeToRealCwd(cwd, full),
			planContent,
			planContentHash: sha256(planContent),
		};
	}
	private async startExistingPlan(
		run: WorkflowRunRecord,
		artifact: ExistingPlanArtifact,
		ctx: WorkflowContext,
	): Promise<WorkflowRunRecord> {
		run.planPath = artifact.planPath;
		run.planContentHash = artifact.planContentHash;
		run.approvedPlanContent = artifact.planContent;
		run.phase = "approved";
		run.logs.push(`${nowIso()} loaded existing plan ${run.planPath}`);
		await saveRun(run);
		await this.continueExecution(run.id, ctx);
		return run;
	}
	async submitPlan(
		runId: string,
		filePath: string,
		ctx: WorkflowContext,
	): Promise<{ approved: boolean; text: string }> {
		const artifact = await this.readPlanArtifact(runId, filePath, [
			"planning",
			"reviewing-plan",
		]);
		assertWorkflowSession(artifact.run, ctx, "planning");
		let { run } = artifact;
		const { full, planContent } = artifact;
		run.planPath = artifact.planPath;
		run.planContentHash = artifact.planContentHash;
		run.approvedPlanContent = undefined;
		run.phase = "reviewing-plan";
		await saveRun(run);
		const review = await reviewPlanWithPlannotator(this.pi, full, planContent);
		const latestRun = await getRun(runId);
		if (!latestRun) throw new Error(`Unknown workflow run: ${runId}`);
		if (
			latestRun.phase !== "reviewing-plan" ||
			latestRun.planContentHash !== artifact.planContentHash
		)
			throw new Error(
				`Workflow run ${runId} changed while plan review was pending; re-submit the current plan before continuing.`,
			);
		run = latestRun;
		if (!review.approved) {
			const safeFeedback = truncateWorkflowText(review.feedback);
			run.logs.push(
				`${nowIso()} plan denied: ${safeFeedback ?? "no feedback"}`,
			);
			run.phase = "planning";
			await saveRun(run);
			return {
				approved: false,
				text: `Plan denied. Revise ${run.planPath} using this feedback, then call workflow_submit_plan again.\n\n${review.feedback ?? "(no feedback)"}`,
			};
		}
		run.phase = "approved";
		run.approvedPlanContent = planContent;
		run.approvalNotes = truncateWorkflowText(review.feedback);
		run.logs.push(`${nowIso()} plan approved review=${review.reviewId}`);
		await saveRun(run);
		const handoffError = await this.queueExecutionHandoff(run.id);
		if (handoffError) {
			return {
				approved: true,
				text: `Plan approved for workflow ${run.id}, but failed to queue execution handoff: ${handoffError}. Run /workflow-continue ${run.id} manually to continue.`,
			};
		}
		return {
			approved: true,
			text: `Plan approved for workflow ${run.id}. Queued fresh execution handoff.`,
		};
	}
	async approvePlan(
		runId: string,
		filePath: string,
		approvalNotes: string | undefined,
		ctx: WorkflowContext,
	): Promise<{ approved: boolean; text: string }> {
		const artifact = await this.readPlanArtifact(runId, filePath, [
			"planning",
			"reviewing-plan",
		]);
		assertWorkflowSession(artifact.run, ctx, "planning");
		const { run, planContent } = artifact;
		run.planPath = artifact.planPath;
		run.planContentHash = artifact.planContentHash;
		run.approvedPlanContent = planContent;
		run.phase = "approved";
		const safeApprovalNotes = truncateWorkflowText(approvalNotes);
		run.approvalNotes = safeApprovalNotes;
		run.logs.push(
			`${nowIso()} plan prompt-approved${safeApprovalNotes ? `: ${safeApprovalNotes}` : ""}`,
		);
		await saveRun(run);
		const handoffError = await this.queueExecutionHandoff(run.id);
		if (handoffError) {
			return {
				approved: true,
				text: `Plan prompt-approved for workflow ${run.id}, but failed to queue execution handoff: ${handoffError}. Run /workflow-continue ${run.id} manually to continue.`,
			};
		}
		return {
			approved: true,
			text: `Plan prompt-approved for workflow ${run.id}. Queued fresh execution handoff.`,
		};
	}
	private async queueExecutionHandoff(
		runId: string,
	): Promise<string | undefined> {
		if (!this.pi.sendUserMessage) {
			return "Pi sendUserMessage API is unavailable";
		}
		try {
			await this.pi.sendUserMessage(`/workflow-continue ${runId}`, {
				deliverAs: "followUp",
			});
			return undefined;
		} catch (error) {
			return errorMessage(error);
		}
	}
	private async readPlanArtifact(
		runId: string,
		filePath: string,
		allowedPhases?: WorkflowRunRecord["phase"][],
	): Promise<{
		run: WorkflowRunRecord;
		full: string;
		planContent: string;
		planPath: string;
		planContentHash: string;
	}> {
		const run = await getRun(runId);
		if (!run) throw new Error(`Unknown workflow run: ${runId}`);
		if (allowedPhases && !allowedPhases.includes(run.phase))
			throw new Error(
				`Workflow run ${runId} is ${run.phase}; plan artifacts can only be submitted or approved while the run is ${allowedPhases.join(" or ")}.`,
			);
		const full = await resolveExistingPlanMarkdownPath(run.cwd, filePath);
		const planContent = await readBoundedPlanMarkdown(full, filePath);
		return {
			run,
			full,
			planContent,
			planPath: await relativeToRealCwd(run.cwd, full),
			planContentHash: sha256(planContent),
		};
	}
	async continueExecution(runId: string, ctx: WorkflowContext): Promise<void> {
		const previous =
			this.continueExecutionLocks.get(runId) ?? Promise.resolve();
		const current = (async () => {
			await previous.catch(() => undefined);
			await withRunLock(runId, "continue", () =>
				this.continueExecutionLocked(runId, ctx),
			);
		})();
		this.continueExecutionLocks.set(runId, current);
		try {
			await current;
		} finally {
			if (this.continueExecutionLocks.get(runId) === current) {
				this.continueExecutionLocks.delete(runId);
			}
		}
	}
	private async continueExecutionLocked(
		runId: string,
		ctx: WorkflowContext,
	): Promise<void> {
		const run = await getRun(runId);
		if (!run) throw new Error(`Unknown workflow run: ${runId}`);
		if (run.phase === "executing") {
			if (run.executionSessionPath) return;
			throw new Error(
				`Workflow run ${runId} is already executing without a recorded execution session; refusing to create a duplicate session.`,
			);
		}
		if (run.phase !== "approved")
			throw new Error(
				`Workflow run ${runId} is ${run.phase}; approve the plan before executing.`,
			);
		if (!run.planPath) throw new Error(`Workflow run ${runId} has no planPath`);
		const full = await resolveExistingPlanMarkdownPath(run.cwd, run.planPath);
		const content = await this.approvedPlanContent(run, full);
		if (!run.planContentHash) run.planContentHash = sha256(content);
		const workflow = await this.findWorkflow(run.cwd, run.workflowName);
		if (!workflow)
			throw new Error(`Unknown workflow for run ${runId}: ${run.workflowName}`);
		const classification = classifyPlanComplexity(content);
		run.selectedComplexity = classification.complexity;
		run.logs.push(
			`${nowIso()} routed plan as ${classification.complexity}: ${classification.reason}`,
		);
		const kickoff = await this.executionKickoff(
			workflow,
			run,
			content,
			classification,
		);
		await saveRun(run);
		const sessionName = `workflow: ${run.workflowName} execution ${run.id}`;
		let executionSessionPath: string | undefined;
		const sessionResult = await ctx.newSession({
			parentSession: ctx.sessionManager?.getSessionFile?.(),
			setup: async (sm) => {
				sm.appendSessionInfo?.(sessionName);
				sm.appendMessage?.({
					role: "user",
					content: [
						{
							type: "text",
							text: `Workflow ${run.id} execution context. Approved/selected plan: ${run.planPath}\n\n${content}`,
						},
					],
					timestamp: Date.now(),
				});
			},
			withSession: async (newCtx) => {
				executionSessionPath = newCtx.sessionManager
					?.getSessionFile?.()
					?.trim();
				if (!executionSessionPath) {
					throw new Error(
						`Workflow run ${runId} execution session did not provide a session file; refusing to mark the run executing.`,
					);
				}
				await newCtx.sendUserMessage(kickoff);
			},
		});
		if (sessionResult.cancelled) {
			throw new Error(`Workflow run ${runId} execution session was cancelled.`);
		}
		if (!executionSessionPath) {
			throw new Error(
				`Workflow run ${runId} execution session did not provide a session file; refusing to mark the run executing.`,
			);
		}
		run.phase = "executing";
		run.executionSessionPath = executionSessionPath;
		await saveRun(run);
	}
	async completeRun(
		runId: string,
		status: "completed" | "failed",
		summary: string | undefined,
		ctx: WorkflowContext,
	): Promise<{ text: string }> {
		const run = await getRun(runId);
		if (!run) throw new Error(`Unknown workflow run: ${runId}`);
		assertWorkflowSession(run, ctx, "execution");
		if (run.phase !== "executing" && run.phase !== status)
			throw new Error(
				`Workflow run ${runId} is ${run.phase}; only executing runs can be completed or failed.`,
			);
		run.phase = status;
		const safeSummary = truncateWorkflowText(summary);
		run.logs.push(
			`${nowIso()} execution ${status}${safeSummary ? `: ${safeSummary}` : ""}`,
		);
		await saveRun(run);
		return { text: `Workflow ${runId} marked ${status}.` };
	}
	private async approvedPlanContent(
		run: WorkflowRunRecord,
		full: string,
	): Promise<string> {
		if (!existsSync(full))
			throw new Error(`Approved plan file no longer exists: ${run.planPath}`);
		const currentContent = await readBoundedPlanMarkdown(
			full,
			run.planPath ?? full,
		);
		const currentHash = sha256(currentContent);
		if (run.planContentHash && currentHash !== run.planContentHash)
			throw new Error(
				`Approved plan changed after approval: ${run.planPath}. Re-submit the plan for review before executing.`,
			);
		const content = run.approvedPlanContent ?? currentContent;
		assertPlanContentWithinLimit(content, run.planPath ?? full);
		return content;
	}
	private async executionKickoff(
		workflow: WorkflowDefinition,
		run: WorkflowRunRecord,
		content: string,
		classification: PlanClassification,
	): Promise<string> {
		const nodes = orderWorkflowNodes(
			executionNodes(workflow, classification.complexity),
		);
		if (nodes.length === 0)
			throw new Error(`Workflow ${workflow.name} has no execution nodes`);
		const nodeIds = new Set(nodes.map((node) => node.id));
		const vars = {
			ARGUMENTS: run.planPath ?? "",
			PLAN_PATH: run.planPath ?? "",
			PLAN_CONTENT: content,
			USER_MESSAGE: run.request ?? "",
			WORKFLOW_ID: run.id,
			ARTIFACTS_DIR: this.artifactsDir(run.cwd, run.id),
			SELECTED_COMPLEXITY: classification.complexity,
			SELECTED_COMPLEXITY_REASON: classification.reason,
		};
		const renderedNodes = await Promise.all(
			nodes.map((node) =>
				this.renderExecutionNode(run.cwd, node, nodeIds, vars),
			),
		);
		return `Execute workflow run ${run.id} from workflow \`${workflow.name}\` using the YAML-derived execution graph below.

You are in a fresh execution session. Do not rely on planning conversation context. Use only the approved/selected plan artifact and workflow metadata in this message.

Workflow router decision:
- classify-plan.output.complexity: ${classification.complexity}
- reason: ${classification.reason}
- Conditional branch nodes whose \`when\` expressions did not match this router decision were omitted before this handoff.

Execution rules:
- Execute the rendered nodes in the listed topological order.
- Respect each rendered node's dependencies and \`trigger_rule\`.
- For command nodes, perform the rendered command instructions exactly for that node.
- Treat the classify-plan node as already having the router output above; do not choose a different implementation branch.
- Track each node as succeeded, skipped, or failed before moving to dependents.
- Escalate to the user for scope/product/architecture changes.
- Do not replace this graph with an ad hoc workflow.

Approved plan path: ${run.planPath}

Approved plan content:
${content}

YAML-derived execution graph:
${renderedNodes.join("\n\n")}`;
	}
	private async renderExecutionNode(
		cwd: string,
		node: WorkflowNode,
		nodeIds: Set<string>,
		vars: Record<string, string>,
	): Promise<string> {
		const dependencies = (node.depends_on ?? []).filter((dep) =>
			nodeIds.has(dep),
		);
		const metadata = [
			`id: ${node.id}`,
			dependencies.length
				? `depends_on: ${dependencies.join(", ")}`
				: undefined,
			node.when ? `when: ${node.when}` : undefined,
			node.trigger_rule ? `trigger_rule: ${node.trigger_rule}` : undefined,
			node.context ? `context: ${node.context}` : undefined,
			node.model ? `model: ${node.model}` : undefined,
			node.thinking ? `thinking: ${node.thinking}` : undefined,
			renderNodeMetadata("modelPolicy", node.modelPolicy),
			renderNodeMetadata("output_format", node.output_format),
			node.output_artifact
				? `output_artifact: ${node.output_artifact}`
				: undefined,
			node.timeout !== undefined ? `timeout: ${node.timeout}` : undefined,
			renderNodeMetadata("loop", node.loop),
		]
			.filter(Boolean)
			.join("\n");

		if (node.command) {
			const command = await this.findCommand(cwd, node.command);
			if (!command) throw new Error(`Missing command: ${node.command}`);
			const routerOutput =
				node.id === "classify-plan"
					? `\n\nOrchestrator precomputed output:\n\`\`\`json\n${JSON.stringify(
							{
								complexity: vars.SELECTED_COMPLEXITY,
								reason: vars.SELECTED_COMPLEXITY_REASON,
							},
							null,
							2,
						)}\n\`\`\``
					: "";
			return `### Node: ${node.id}\n${metadata}\ncommand: ${node.command}\n\n${this.renderCommand(command, vars)}${routerOutput}`;
		}
		if (node.prompt)
			return `### Node: ${node.id}\n${metadata}\nprompt:\n${renderTemplate(node.prompt, vars)}`;
		if (node.bash)
			return `### Node: ${node.id}\n${metadata}\nbash:\n\`\`\`bash\n${renderTemplate(node.bash, vars)}\n\`\`\``;
		if (node.script)
			return `### Node: ${node.id}\n${metadata}\nscript:\n\`\`\`\n${renderTemplate(node.script, vars)}\n\`\`\``;
		if (node.subagent)
			return `### Node: ${node.id}\n${metadata}\nsubagent:\n\`\`\`json\n${JSON.stringify(node.subagent, null, 2)}\n\`\`\``;
		if (node.workerReviewLoop)
			return `### Node: ${node.id}\n${metadata}\nworkerReviewLoop:\n\`\`\`json\n${JSON.stringify(node.workerReviewLoop, null, 2)}\n\`\`\``;
		if (node.worktreeWave)
			return `### Node: ${node.id}\n${metadata}\nworktreeWave:\n\`\`\`json\n${JSON.stringify(node.worktreeWave, null, 2)}\n\`\`\``;
		return `### Node: ${node.id}\n${metadata}\nUnsupported execution node type; mark failed and report this workflow definition issue.`;
	}
	renderCommand(
		command: WorkflowCommand,
		vars: Record<string, string>,
	): string {
		return renderTemplate(command.content, vars);
	}
	artifactsDir(cwd: string, runId: string): string {
		return join(cwd, ".pi", "workflow-runs", normalizeWorkflowRunId(runId));
	}
}
type PlanComplexity = NonNullable<WorkflowRunRecord["selectedComplexity"]>;
type PlanClassification = { complexity: PlanComplexity; reason: string };

function executionNodes(
	workflow: WorkflowDefinition,
	selectedComplexity: PlanComplexity,
): WorkflowNode[] {
	return workflow.nodes.filter(
		(node) =>
			node.id !== "create-plan" &&
			node.id !== "classify-plan" &&
			!isNonExecutionLoaderNode(node) &&
			!node.handoff &&
			!node.approval &&
			!node.plannotator_review &&
			matchesWhen(node.when, selectedComplexity),
	);
}

function isNonExecutionLoaderNode(node: WorkflowNode): boolean {
	return (
		node.id === "load-plan" ||
		Boolean(node.output_artifact && node.context === "newSession")
	);
}

function assertWorkflowSession(
	run: WorkflowRunRecord,
	ctx: WorkflowContext,
	kind: "planning" | "execution",
): void {
	const expected =
		kind === "planning" ? run.planningSessionPath : run.executionSessionPath;
	if (!expected?.trim()) {
		throw new Error(
			`Workflow run ${run.id} has no recorded ${kind} session path; refusing to mutate it from this tool call.`,
		);
	}
	const current = ctx.sessionManager?.getSessionFile?.()?.trim();
	if (!current) {
		throw new Error(
			`Workflow run ${run.id} ${kind} tools must be called from its recorded ${kind} session. Current session is unavailable; expected ${expected}.`,
		);
	}
	if (resolve(current) !== resolve(expected)) {
		throw new Error(
			`Workflow run ${run.id} ${kind} tools must be called from its recorded ${kind} session. Current session is ${current}; expected ${expected}.`,
		);
	}
}

function matchesWhen(
	when: string | undefined,
	selectedComplexity: PlanComplexity,
): boolean {
	if (!when) return true;
	const match = when.match(
		/^\$classify-plan\.output\.complexity\s*==\s*['"](simple|medium|complex)['"]$/,
	);
	if (!match)
		throw new Error(
			`Unsupported workflow when expression: ${when}. Supported form: $classify-plan.output.complexity == 'simple|medium|complex'`,
		);
	return match[1] === selectedComplexity;
}

function classifyPlanComplexity(content: string): PlanClassification {
	const lower = content.toLowerCase();
	const checklistItems =
		content.match(/^\s*(?:[-*]\s+\[[ xX]\]|\d+[.)]\s+)/gm)?.length ?? 0;
	const fileRefs = new Set(content.match(/(?:[\w.-]+\/)+[\w.-]+\.\w+/g) ?? [])
		.size;
	const complexKeywords = [
		"migration",
		"schema",
		"contract",
		"multi-module",
		"architecture",
		"breaking change",
		"parallel",
	];
	const mediumKeywords = ["test", "integration", "multiple files", "refactor"];
	const complexKeyword = complexKeywords.find((keyword) =>
		lower.includes(keyword),
	);
	if (checklistItems >= 6 || fileRefs >= 6)
		return {
			complexity: "complex",
			reason: `${checklistItems} checklist items and ${fileRefs} referenced files`,
		};
	if (complexKeyword && (checklistItems >= 4 || fileRefs >= 4))
		return {
			complexity: "complex",
			reason: `contains ${complexKeyword} with ${checklistItems} checklist items and ${fileRefs} referenced files`,
		};
	const mediumKeyword = mediumKeywords.find((keyword) =>
		lower.includes(keyword),
	);
	if (checklistItems >= 3 || fileRefs >= 3 || mediumKeyword)
		return {
			complexity: "medium",
			reason: mediumKeyword
				? `contains ${mediumKeyword}`
				: `${checklistItems} checklist items and ${fileRefs} referenced files`,
		};
	return {
		complexity: "simple",
		reason: `${checklistItems} checklist items and ${fileRefs} referenced files`,
	};
}

function orderWorkflowNodes(nodes: WorkflowNode[]): WorkflowNode[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const ordered: WorkflowNode[] = [];
	const state = new Map<string, "visiting" | "visited">();

	function visit(node: WorkflowNode): void {
		const currentState = state.get(node.id);
		if (currentState === "visited") return;
		if (currentState === "visiting")
			throw new Error(`Workflow cycle at node ${node.id}`);
		state.set(node.id, "visiting");
		for (const dep of node.depends_on ?? []) {
			const dependency = byId.get(dep);
			if (dependency) visit(dependency);
		}
		state.set(node.id, "visited");
		ordered.push(node);
	}

	for (const node of nodes) visit(node);
	return ordered;
}

function renderTemplate(text: string, vars: Record<string, string>): string {
	return text.replace(/\$([A-Z][A-Z0-9_]*)/g, (match, key: string) => {
		return vars[key] ?? match;
	});
}

function renderNodeMetadata(name: string, value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return `${name}: ${JSON.stringify(value)}`;
}

function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}
function short(cwd: string, path: string | undefined): string {
	return path ? relative(cwd, path) || basename(path) : "builtin";
}

import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
	type WorkflowContext as RunnerWorkflowContext,
	WorkflowRunner,
} from "./src/runner";
import { getRun, listRuns, workflowRunStorePath } from "./src/store";
import { isValidWorkflowRunId } from "./src/utils";
import type { WorkflowRunRecord } from "./src/workflow-types";

type NotifyLevel = "info" | "error" | string;
type WorkflowUi = {
	notify(text: string, level?: NotifyLevel): void;
	setStatus?: (name: string, status: string) => void;
	setWidget?: (name: string, widget: () => { render: () => string[] }) => void;
};
type WorkflowContext = RunnerWorkflowContext & {
	hasUI?: boolean;
	ui: WorkflowUi;
};
type WorkflowToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
};
type WorkflowTool = {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: TSchema;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: WorkflowContext,
	) => Promise<WorkflowToolResult>;
};
type WorkflowCommand = {
	description: string;
	handler: (args: string | undefined, ctx: WorkflowContext) => Promise<void>;
};
type EventsLike = {
	emit(channel: string, payload: unknown): void;
	on(
		channel: string,
		handler: (data: unknown) => void,
	): undefined | (() => void);
};

type PiApi = {
	events: EventsLike;
	on(
		event: "session_start",
		handler: (event: unknown, ctx: WorkflowContext) => void | Promise<void>,
	): void;
	registerCommand(name: string, command: WorkflowCommand): void;
	registerTool(tool: WorkflowTool): void;
};
const runIdSchema = Type.Refine(
	Type.String({
		minLength: 1,
		description:
			"Pi workflow run id, e.g. pwf-1234abcd or pwf-0123456789abcdef0123456789abcdef",
	}),
	isValidWorkflowRunId,
);
const planFilePathSchema = Type.Refine(
	Type.String({
		minLength: 1,
		description: "Markdown plan path relative to workflow cwd",
	}),
	(value) => value.trim().length > 0,
);
const approvePlanParameters = Type.Object(
	{
		runId: runIdSchema,
		filePath: planFilePathSchema,
		approvalNotes: Type.Optional(
			Type.String({
				description: "Optional user approval notes or constraints",
			}),
		),
	},
	{ additionalProperties: false },
);
const submitPlanParameters = Type.Object(
	{
		runId: runIdSchema,
		filePath: planFilePathSchema,
	},
	{ additionalProperties: false },
);
const completeRunParameters = Type.Object(
	{
		runId: runIdSchema,
		status: Type.Union([Type.Literal("completed"), Type.Literal("failed")], {
			description: "Final workflow status",
		}),
		summary: Type.Optional(
			Type.String({
				description: "Brief execution and validation summary",
			}),
		),
	},
	{ additionalProperties: false },
);
type ApprovePlanToolInput = Static<typeof approvePlanParameters>;
type SubmitPlanToolInput = Static<typeof submitPlanParameters>;
type CompleteRunInput = Static<typeof completeRunParameters>;

export default function piWorkflows(pi: PiApi) {
	const runner = new WorkflowRunner(pi, import.meta.url);
	let lastStatus = "idle";

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			ctx.ui.setStatus?.("workflow", lastStatus);
			ctx.ui.setWidget?.("workflow", () => ({
				render: () =>
					lastStatus === "idle" ? [] : [`pi-workflows: ${lastStatus}`],
			}));
		}
	});

	pi.registerCommand("workflows", {
		description:
			"List Pi workflows discovered from built-in, global, and project YAML files",
		handler: async (_args, ctx) => {
			const text = await runner.list(ctx.cwd);
			ctx.ui.notify(text, "info");
			return;
		},
	});

	pi.registerCommand("workflow", {
		description: "Run a Pi workflow: /workflow <name> [arguments]",
		handler: async (args, ctx) => {
			const [name, ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
			if (!name) {
				ctx.ui.notify(await runner.list(ctx.cwd), "info");
				return;
			}
			lastStatus = `starting ${name}`;
			ctx.ui.setStatus?.("workflow", lastStatus);
			await runner.startWorkflow(name, rest.join(" "), ctx);
		},
	});

	pi.registerCommand("workflow-status", {
		description: "Show Pi workflow run status",
		handler: async (args, ctx) => {
			const id = args?.trim();
			if (id) {
				if (!isValidWorkflowRunId(id)) {
					ctx.ui.notify(invalidRunIdMessage("workflow-status", id), "error");
					return;
				}
				const run = await getRun(id);
				ctx.ui.notify(
					run ? formatRun(run) : `No workflow run found for ${id}`,
					run ? "info" : "error",
				);
				return;
			}
			const runs = (await listRuns()).slice(0, 10);
			ctx.ui.notify(
				runs.length
					? runs.map(formatRun).join("\n\n")
					: `No workflow runs. Store: ${workflowRunStorePath}`,
				"info",
			);
		},
	});

	pi.registerCommand("workflow-continue", {
		description: "Continue a Pi workflow run after plan approval",
		handler: async (args, ctx) => {
			const runId = args?.trim();
			if (!runId) {
				ctx.ui.notify("Usage: /workflow-continue <runId>", "error");
				return;
			}
			if (!isValidWorkflowRunId(runId)) {
				ctx.ui.notify(invalidRunIdMessage("workflow-continue", runId), "error");
				return;
			}
			const run = await getRun(runId);
			if (!run) {
				ctx.ui.notify(`No workflow run found for ${runId}`, "error");
				return;
			}
			lastStatus = `${runId} handoff`;
			ctx.ui.setStatus?.("workflow", lastStatus);
			await runner.continueExecution(runId, ctx);
		},
	});

	pi.registerCommand("workflow-resume", {
		description: "Resume a Pi workflow run from its persisted plan artifact",
		handler: async (args, ctx) => {
			const runId = args?.trim();
			if (!runId) {
				ctx.ui.notify("Usage: /workflow-resume <runId>", "error");
				return;
			}
			if (!isValidWorkflowRunId(runId)) {
				ctx.ui.notify(invalidRunIdMessage("workflow-resume", runId), "error");
				return;
			}
			const run = await getRun(runId);
			if (!run) {
				ctx.ui.notify(`No workflow run found for ${runId}`, "error");
				return;
			}
			await runner.continueExecution(runId, ctx);
		},
	});

	pi.registerTool({
		name: "workflow_approve_plan",
		label: "Workflow Approve Plan",
		description:
			"Approve a workflow plan artifact without Plannotator browser review. Used by prompt-only planning workflows.",
		promptSnippet:
			"Approve a pi-workflows plan artifact without Plannotator review",
		promptGuidelines: [
			"Use workflow_approve_plan only when the user has approved the plan in prompt conversation or the workflow explicitly skips Plannotator.",
		],
		parameters: approvePlanParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = parseApprovePlanToolInput(params);
			const result = await runner.approvePlan(
				input.runId,
				input.filePath,
				input.approvalNotes,
				ctx,
			);
			lastStatus = `${input.runId} approved`;
			ctx.ui.setStatus?.("workflow", lastStatus);
			return {
				content: [{ type: "text", text: result.text }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "workflow_submit_plan",
		label: "Workflow Submit Plan",
		description:
			"Submit a workflow plan artifact through Plannotator's event API. Used by pi-workflows planning sessions instead of plannotator_submit_plan.",
		promptSnippet:
			"Submit a pi-workflows plan artifact for Plannotator review via event API",
		promptGuidelines: [
			"Use workflow_submit_plan in pi-workflows planning sessions when the plan markdown file is ready for review.",
		],
		parameters: submitPlanParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = parseSubmitPlanToolInput(params);
			const result = await runner.submitPlan(input.runId, input.filePath, ctx);
			lastStatus = `${input.runId} ${result.approved ? "approved" : "planning"}`;
			ctx.ui.setStatus?.("workflow", lastStatus);
			return {
				content: [{ type: "text", text: result.text }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "workflow_complete_run",
		label: "Workflow Complete Run",
		description:
			"Mark a pi-workflows execution run completed or failed after final validation.",
		promptSnippet:
			"Mark a pi-workflows execution run completed or failed after final validation",
		promptGuidelines: [
			"Use workflow_complete_run at the end of a pi-workflows execution session after final validation has completed.",
		],
		parameters: completeRunParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const input = parseCompleteRunInput(params);
			const result = await runner.completeRun(
				input.runId,
				input.status,
				input.summary,
				ctx,
			);
			lastStatus = `${input.runId} ${input.status}`;
			ctx.ui.setStatus?.("workflow", lastStatus);
			return {
				content: [{ type: "text", text: result.text }],
				details: result,
			};
		},
	});
}

export function parseApprovePlanToolInput(
	params: unknown,
): ApprovePlanToolInput {
	if (!Value.Check(approvePlanParameters, params)) {
		throw new Error("Tool parameters must match workflow plan approval schema");
	}
	return params;
}

export function parseSubmitPlanToolInput(params: unknown): SubmitPlanToolInput {
	if (!Value.Check(submitPlanParameters, params)) {
		throw new Error("Tool parameters must match workflow plan submit schema");
	}
	return params;
}

function parseCompleteRunInput(params: unknown): CompleteRunInput {
	if (!Value.Check(completeRunParameters, params)) {
		throw new Error("Tool parameters must match workflow completion schema");
	}
	return params;
}

function invalidRunIdMessage(command: string, runId: string): string {
	const usage =
		command === "workflow-status"
			? "/workflow-status [runId]"
			: `/${command} <runId>`;
	return `Usage: ${usage}\nInvalid workflow run id: ${runId}`;
}

function formatRun(run: WorkflowRunRecord): string {
	return `${run.id} · ${run.workflowName} · ${run.phase}\nplan: ${run.planPath ?? "(none)"}\nupdated: ${run.updatedAt}\n${(run.logs ?? []).slice(-3).join("\n")}`;
}

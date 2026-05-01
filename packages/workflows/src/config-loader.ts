import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { relativePathEscapesRoot } from "./utils";
import type {
	LoadedConfig,
	WorkflowCommand,
	WorkflowDefinition,
	WorkflowNode,
} from "./workflow-types";
import { loadYamlFile } from "./yaml-loader";

const nonEmptyStringSchema = Type.Refine(
	Type.String({ minLength: 1 }),
	(value) => value.trim().length > 0,
);
const thinkingLevelSchema = Type.Union([
	Type.Literal("inherit"),
	Type.Literal("auto"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
]);
const strictObjectOptions = { additionalProperties: false };
const modelPolicySchema = Type.Object(
	{
		model: Type.Optional(Type.String()),
		models: Type.Optional(Type.Array(Type.String())),
		autoSelectModel: Type.Optional(Type.Boolean()),
		thinking: Type.Optional(thinkingLevelSchema),
	},
	strictObjectOptions,
);
const workflowLoopSchema = Type.Object(
	{
		prompt: Type.Optional(Type.String()),
		command: Type.Optional(Type.String()),
		until: Type.String(),
		max_iterations: Type.Integer({ minimum: 1 }),
		fresh_context: Type.Optional(Type.Boolean()),
		until_bash: Type.Optional(Type.String()),
	},
	strictObjectOptions,
);
const workflowApprovalSchema = Type.Object(
	{
		message: Type.String(),
		capture_response: Type.Optional(Type.Boolean()),
		on_reject: Type.Optional(
			Type.Object(
				{
					prompt: Type.String(),
					max_attempts: Type.Optional(Type.Integer({ minimum: 1 })),
				},
				strictObjectOptions,
			),
		),
	},
	strictObjectOptions,
);
const plannotatorReviewSchema = Type.Object(
	{
		artifact: Type.Optional(Type.String()),
		filePath: Type.Optional(Type.String()),
		loopOnDenied: Type.Optional(Type.Boolean()),
	},
	strictObjectOptions,
);
const handoffSchema = Type.Object(
	{
		mode: Type.Literal("newSession"),
		seed: Type.Union([
			Type.Literal("approvedPlanOnly"),
			Type.Literal("planOnly"),
		]),
		artifacts: Type.Optional(Type.Array(Type.String())),
		required: Type.Optional(Type.Boolean()),
	},
	strictObjectOptions,
);
const subagentTaskSchema = Type.Object(
	{
		agent: Type.String(),
		task: Type.String(),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(thinkingLevelSchema),
		output: Type.Optional(Type.Union([Type.String(), Type.Boolean()])),
	},
	strictObjectOptions,
);
const subagentSchema = Type.Object(
	{
		agent: Type.Optional(Type.String()),
		task: Type.Optional(Type.String()),
		tasks: Type.Optional(Type.Array(subagentTaskSchema)),
		context: Type.Optional(
			Type.Union([Type.Literal("fresh"), Type.Literal("fork")]),
		),
		concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
		worktree: Type.Optional(Type.Boolean()),
	},
	strictObjectOptions,
);
const workerReviewLoopSchema = Type.Object(
	{
		worker: Type.Optional(Type.String()),
		reviewer: Type.Optional(Type.String()),
		maxRounds: Type.Integer({ minimum: 1 }),
		scope: Type.Optional(
			Type.Union([
				Type.Literal("plan"),
				Type.Literal("task"),
				Type.Literal("diff"),
			]),
		),
	},
	strictObjectOptions,
);
const worktreeWaveSchema = Type.Object(
	{
		worker: Type.Optional(Type.String()),
		reviewer: Type.Optional(Type.String()),
		maxRounds: Type.Optional(Type.Integer({ minimum: 1 })),
		parallelWorkers: Type.Optional(Type.Boolean()),
	},
	strictObjectOptions,
);
const workflowNodeSchema = Type.Object(
	{
		id: nonEmptyStringSchema,
		depends_on: Type.Optional(Type.Array(Type.String())),
		when: Type.Optional(Type.String()),
		trigger_rule: Type.Optional(
			Type.Union([
				Type.Literal("all_success"),
				Type.Literal("one_success"),
				Type.Literal("none_failed_min_one_success"),
			]),
		),
		command: Type.Optional(Type.String()),
		prompt: Type.Optional(Type.String()),
		bash: Type.Optional(Type.String()),
		script: Type.Optional(Type.String()),
		context: Type.Optional(
			Type.Union([
				Type.Literal("fresh"),
				Type.Literal("newSession"),
				Type.Literal("inherit"),
			]),
		),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(thinkingLevelSchema),
		modelPolicy: Type.Optional(modelPolicySchema),
		output_format: Type.Optional(Type.Unknown()),
		output_artifact: Type.Optional(Type.String()),
		timeout: Type.Optional(Type.Number()),
		loop: Type.Optional(workflowLoopSchema),
		approval: Type.Optional(workflowApprovalSchema),
		plannotator_review: Type.Optional(plannotatorReviewSchema),
		handoff: Type.Optional(handoffSchema),
		subagent: Type.Optional(subagentSchema),
		workerReviewLoop: Type.Optional(workerReviewLoopSchema),
		worktreeWave: Type.Optional(worktreeWaveSchema),
	},
	strictObjectOptions,
);
const workflowDefinitionSchema = Type.Object(
	{
		name: nonEmptyStringSchema,
		description: nonEmptyStringSchema,
		modelPolicy: Type.Optional(Type.Record(Type.String(), modelPolicySchema)),
		nodes: Type.Array(workflowNodeSchema, { minItems: 1 }),
	},
	strictObjectOptions,
);

async function listFiles(
	dir: string,
	extensions: Set<string>,
): Promise<string[]> {
	if (!existsSync(dir)) return [];
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await listFiles(full, extensions)));
		else if (
			entry.isFile() &&
			extensions.has(extname(entry.name).toLowerCase())
		)
			out.push(full);
	}
	return out;
}

function validateWorkflow(
	value: unknown,
	sourcePath: string,
): WorkflowDefinition {
	if (!Value.Check(workflowDefinitionSchema, value)) {
		throw new Error("workflow root must match workflow schema");
	}
	validateModelPolicyStages(value.modelPolicy);
	const ids = new Set<string>();
	const nodes = value.nodes.map((node, index) =>
		validateNode(node, index, ids),
	);
	for (const node of nodes) {
		for (const dep of node.depends_on ?? []) {
			if (!ids.has(dep))
				throw new Error(`node ${node.id} depends_on unknown node ${dep}`);
		}
	}
	validateNoDependencyCycles(nodes);
	return {
		...value,
		nodes,
		sourcePath,
	};
}

function validateModelPolicyStages(
	modelPolicy: WorkflowDefinition["modelPolicy"],
): void {
	if (!modelPolicy) return;
	const supportedStages = new Set(["default", "planning"]);
	const unsupported = Object.keys(modelPolicy).filter(
		(stage) => !supportedStages.has(stage),
	);
	if (unsupported.length > 0) {
		throw new Error(
			`workflow modelPolicy has unsupported stage keys: ${unsupported.join(", ")}. Supported keys: default, planning`,
		);
	}
}

function validateNoDependencyCycles(nodes: WorkflowNode[]): void {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const state = new Map<string, "visiting" | "visited">();
	const stack: string[] = [];

	function visit(node: WorkflowNode): void {
		const currentState = state.get(node.id);
		if (currentState === "visited") return;
		if (currentState === "visiting") {
			const cycleStart = stack.indexOf(node.id);
			const cycle = [...stack.slice(Math.max(0, cycleStart)), node.id];
			throw new Error(`workflow dependency cycle: ${cycle.join(" -> ")}`);
		}
		state.set(node.id, "visiting");
		stack.push(node.id);
		for (const dep of node.depends_on ?? []) {
			const dependency = byId.get(dep);
			if (dependency) visit(dependency);
		}
		stack.pop();
		state.set(node.id, "visited");
	}

	for (const node of nodes) visit(node);
}

function validateNode(
	value: unknown,
	index: number,
	ids: Set<string>,
): WorkflowNode {
	if (!Value.Check(workflowNodeSchema, value)) {
		throw new Error(`node[${index}] must match workflow node schema`);
	}
	if (ids.has(value.id)) throw new Error(`duplicate node id: ${value.id}`);
	ids.add(value.id);
	if (value.when !== undefined && !isSupportedWhenExpression(value.when)) {
		throw new Error(
			`node ${value.id}.when has unsupported expression: ${value.when}`,
		);
	}
	const typeFields = [
		["command", value.command],
		["prompt", value.prompt],
		["bash", value.bash],
		["script", value.script],
		["approval", value.approval],
		["plannotator_review", value.plannotator_review],
		["handoff", value.handoff],
		["subagent", value.subagent],
		["workerReviewLoop", value.workerReviewLoop],
		["worktreeWave", value.worktreeWave],
	]
		.filter(([, fieldValue]) => fieldValue !== undefined)
		.map(([fieldName]) => fieldName);
	if (typeFields.length !== 1)
		throw new Error(
			`node ${value.id} must define exactly one node type; got ${typeFields.join(", ") || "none"}`,
		);
	return value;
}

function validateWorkflowCommands(
	workflow: WorkflowDefinition,
	commandsByName: Map<string, WorkflowCommand>,
): string[] {
	return workflow.nodes
		.filter((node) => node.command && !commandsByName.has(node.command))
		.map(
			(node) =>
				`node ${node.id} references unknown command ${node.command ?? ""}`,
		);
}

function isSupportedWhenExpression(when: string): boolean {
	return /^\$classify-plan\.output\.complexity\s*==\s*['"](simple|medium|complex)['"]$/.test(
		when,
	);
}

function parseCommandFrontmatter(raw: string): {
	data: Record<string, string>;
	body: string;
} {
	if (!raw.startsWith("---\n")) return { data: {}, body: raw };
	const end = raw.indexOf("\n---", 4);
	if (end === -1) return { data: {}, body: raw };
	const fm = raw.slice(4, end).trim();
	const body = raw.slice(end + 4).replace(/^\n/, "");
	const data: Record<string, string> = {};
	for (const line of fm.split("\n")) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (match) data[match[1]] = match[2].replace(/^["']|["']$/g, "");
	}
	return { data, body };
}

async function loadCommands(dir: string): Promise<WorkflowCommand[]> {
	const files = await listFiles(dir, new Set([".md"]));
	const commands: WorkflowCommand[] = [];
	for (const file of files) {
		const raw = await readFile(file, "utf8");
		const parsed = parseCommandFrontmatter(raw);
		commands.push({
			name: basename(file, ".md"),
			description: parsed.data.description,
			argumentHint: parsed.data["argument-hint"],
			content: parsed.body,
			sourcePath: file,
		});
	}
	return commands;
}

async function projectLocalDirInsideCwd(
	cwd: string,
	dir: string,
	kind: string,
	diagnostics: string[],
): Promise<boolean> {
	if (!existsSync(dir)) return true;
	const [realCwd, realDir] = await Promise.all([realpath(cwd), realpath(dir)]);
	const relativePath = relative(realCwd, realDir);
	if (!relativePathEscapesRoot(relativePath)) return true;
	diagnostics.push(
		`${dir}: skipped project-local ${kind} directory because its real path is outside workflow cwd`,
	);
	return false;
}

export async function loadWorkflowConfig(
	cwd: string,
	extensionRoot: string,
): Promise<LoadedConfig> {
	const diagnostics: string[] = [];
	const workflowDirs = [
		{ path: join(extensionRoot, "workflows", "defaults"), projectLocal: false },
		{ path: join(homedir(), ".pi", "agent", "workflows"), projectLocal: false },
		{ path: resolve(cwd, ".pi", "workflows"), projectLocal: true },
	];
	const commandDirs = [
		{ path: join(extensionRoot, "commands", "defaults"), projectLocal: false },
		{
			path: join(homedir(), ".pi", "agent", "workflow-commands"),
			projectLocal: false,
		},
		{ path: resolve(cwd, ".pi", "workflow-commands"), projectLocal: true },
	];

	const workflowsByName = new Map<string, WorkflowDefinition>();
	for (const dir of workflowDirs) {
		if (
			dir.projectLocal &&
			!(await projectLocalDirInsideCwd(cwd, dir.path, "workflow", diagnostics))
		) {
			continue;
		}
		const files = await listFiles(dir.path, new Set([".yaml", ".yml"]));
		for (const file of files) {
			try {
				const workflow = validateWorkflow(await loadYamlFile(file), file);
				workflowsByName.set(workflow.name, workflow);
			} catch (err) {
				diagnostics.push(
					`${file}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	const commandsByName = new Map<string, WorkflowCommand>();
	for (const dir of commandDirs) {
		if (
			dir.projectLocal &&
			!(await projectLocalDirInsideCwd(cwd, dir.path, "command", diagnostics))
		) {
			continue;
		}
		for (const command of await loadCommands(dir.path))
			commandsByName.set(command.name, command);
	}

	for (const [name, workflow] of workflowsByName) {
		const commandDiagnostics = validateWorkflowCommands(
			workflow,
			commandsByName,
		);
		if (commandDiagnostics.length === 0) continue;
		workflowsByName.delete(name);
		for (const diagnostic of commandDiagnostics) {
			diagnostics.push(`${workflow.sourcePath}: ${diagnostic}`);
		}
	}

	return {
		workflows: [...workflowsByName.values()],
		commands: [...commandsByName.values()],
		diagnostics,
	};
}

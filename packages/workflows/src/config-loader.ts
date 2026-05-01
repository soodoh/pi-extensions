import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
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
const modelPolicySchema = Type.Object({
	model: Type.Optional(Type.String()),
	models: Type.Optional(Type.Array(Type.String())),
	autoSelectModel: Type.Optional(Type.Boolean()),
	thinking: Type.Optional(thinkingLevelSchema),
});
const workflowLoopSchema = Type.Object({
	prompt: Type.Optional(Type.String()),
	command: Type.Optional(Type.String()),
	until: Type.String(),
	max_iterations: Type.Integer({ minimum: 1 }),
	fresh_context: Type.Optional(Type.Boolean()),
	until_bash: Type.Optional(Type.String()),
});
const workflowApprovalSchema = Type.Object({
	message: Type.String(),
	capture_response: Type.Optional(Type.Boolean()),
	on_reject: Type.Optional(
		Type.Object({
			prompt: Type.String(),
			max_attempts: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
	),
});
const plannotatorReviewSchema = Type.Object({
	artifact: Type.Optional(Type.String()),
	filePath: Type.Optional(Type.String()),
	loopOnDenied: Type.Optional(Type.Boolean()),
});
const handoffSchema = Type.Object({
	mode: Type.Literal("newSession"),
	seed: Type.Union([
		Type.Literal("approvedPlanOnly"),
		Type.Literal("planOnly"),
	]),
	artifacts: Type.Optional(Type.Array(Type.String())),
	required: Type.Optional(Type.Boolean()),
});
const subagentTaskSchema = Type.Object({
	agent: Type.String(),
	task: Type.String(),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(thinkingLevelSchema),
	output: Type.Optional(Type.Union([Type.String(), Type.Boolean()])),
});
const subagentSchema = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(subagentTaskSchema)),
	context: Type.Optional(
		Type.Union([Type.Literal("fresh"), Type.Literal("fork")]),
	),
	concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
	worktree: Type.Optional(Type.Boolean()),
});
const workerReviewLoopSchema = Type.Object({
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
});
const worktreeWaveSchema = Type.Object({
	worker: Type.Optional(Type.String()),
	reviewer: Type.Optional(Type.String()),
	maxRounds: Type.Optional(Type.Integer({ minimum: 1 })),
	parallelWorkers: Type.Optional(Type.Boolean()),
});
const workflowNodeSchema = Type.Object({
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
});
const workflowDefinitionSchema = Type.Object({
	name: nonEmptyStringSchema,
	description: nonEmptyStringSchema,
	modelPolicy: Type.Optional(Type.Record(Type.String(), modelPolicySchema)),
	nodes: Type.Array(workflowNodeSchema, { minItems: 1 }),
});

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
	return {
		...value,
		nodes,
		sourcePath,
	};
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

export async function loadWorkflowConfig(
	cwd: string,
	extensionRoot: string,
): Promise<LoadedConfig> {
	const diagnostics: string[] = [];
	const workflowDirs = [
		join(extensionRoot, "workflows", "defaults"),
		join(homedir(), ".pi", "agent", "workflows"),
		resolve(cwd, ".pi", "workflows"),
	];
	const commandDirs = [
		join(extensionRoot, "commands", "defaults"),
		join(homedir(), ".pi", "agent", "workflow-commands"),
		resolve(cwd, ".pi", "workflow-commands"),
	];

	const workflowsByName = new Map<string, WorkflowDefinition>();
	for (const dir of workflowDirs) {
		const files = await listFiles(dir, new Set([".yaml", ".yml"]));
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
		for (const command of await loadCommands(dir))
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

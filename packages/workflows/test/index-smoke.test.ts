import { beforeEach, describe, expect, test, vi } from "vitest";

const runnerMethods = vi.hoisted(() => ({
	list: vi.fn(async () => "workflow list"),
	startWorkflow: vi.fn(async () => undefined),
	continueExecution: vi.fn(async () => undefined),
	approvePlan: vi.fn(async () => ({ approved: true, text: "approved" })),
	submitPlan: vi.fn(async () => ({ approved: true, text: "submitted" })),
	completeRun: vi.fn(async () => ({ text: "completed" })),
}));

vi.mock("../src/runner", () => ({
	WorkflowRunner: vi.fn(function WorkflowRunner() {
		return runnerMethods;
	}),
}));

const { default: piWorkflows } = await import("../index");

type WorkflowExtension = typeof piWorkflows;
type PiApi = Parameters<WorkflowExtension>[0];
type Command = Parameters<PiApi["registerCommand"]>[1];
type Tool = Parameters<PiApi["registerTool"]>[0];
type Context = Parameters<Command["handler"]>[1];

function createPi() {
	const commands = new Map<string, Command>();
	const tools = new Map<string, Tool>();
	return {
		commands,
		tools,
		events: {
			emit() {},
			on() {
				return undefined;
			},
		},
		on() {},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		registerTool(tool: Tool) {
			tools.set(tool.name, tool);
		},
	};
}

function createContext(): Context {
	return {
		cwd: process.cwd(),
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
		async newSession() {},
		async sendUserMessage() {},
	};
}

beforeEach(() => {
	for (const method of Object.values(runnerMethods)) method.mockClear();
});

describe("pi workflows extension entrypoint", () => {
	test("registers commands/tools and routes one command plus every tool callback", async () => {
		const pi = createPi();
		piWorkflows(pi);

		expect([...pi.commands.keys()].sort()).toEqual([
			"workflow",
			"workflow-continue",
			"workflow-resume",
			"workflow-status",
			"workflows",
		]);
		expect([...pi.tools.keys()].sort()).toEqual([
			"workflow_approve_plan",
			"workflow_complete_run",
			"workflow_submit_plan",
		]);

		const ctx = createContext();
		await pi.commands.get("workflows")?.handler(undefined, ctx);
		expect(runnerMethods.list).toHaveBeenCalledWith(ctx.cwd);
		expect(ctx.ui.notify).toHaveBeenCalledWith("workflow list", "info");

		await expect(
			pi.tools.get("workflow_approve_plan")?.execute(
				"tool-1",
				{
					runId: "pwf-11111111",
					filePath: "plan.md",
					approvalNotes: "approved in chat",
				},
				undefined,
				undefined,
				ctx,
			),
		).resolves.toMatchObject({ content: [{ type: "text", text: "approved" }] });
		expect(runnerMethods.approvePlan).toHaveBeenCalledWith(
			"pwf-11111111",
			"plan.md",
			"approved in chat",
			ctx,
		);

		await expect(
			pi.tools
				.get("workflow_submit_plan")
				?.execute(
					"tool-2",
					{ runId: "pwf-22222222", filePath: "plan.md" },
					undefined,
					undefined,
					ctx,
				),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "submitted" }],
		});
		expect(runnerMethods.submitPlan).toHaveBeenCalledWith(
			"pwf-22222222",
			"plan.md",
			ctx,
		);

		await expect(
			pi.tools.get("workflow_complete_run")?.execute(
				"tool-3",
				{
					runId: "pwf-33333333",
					status: "completed",
					summary: "done",
				},
				undefined,
				undefined,
				ctx,
			),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "completed" }],
		});
		expect(runnerMethods.completeRun).toHaveBeenCalledWith(
			"pwf-33333333",
			"completed",
			"done",
			ctx,
		);
	});
});

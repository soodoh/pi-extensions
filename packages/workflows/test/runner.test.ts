import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkflowContext } from "../src/runner";
import type { WorkflowRunRecord } from "../src/workflow-types";

async function importRunnerWithHome(home: string) {
	vi.resetModules();
	vi.doMock("node:os", () => ({ homedir: () => home }));
	return import("../src/runner");
}

const tempDirs: string[] = [];

async function tempDir(name: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `${name}-`));
	tempDirs.push(dir);
	return dir;
}

function workflowCtx(cwd: string, sessionFile?: string): WorkflowContext {
	return {
		cwd,
		sessionManager: sessionFile
			? {
					getSessionFile: () => sessionFile,
				}
			: undefined,
		async sendUserMessage() {},
		async newSession() {},
	};
}

function runRecord(
	id: string,
	cwd: string,
	phase: WorkflowRunRecord["phase"],
): WorkflowRunRecord {
	return {
		id,
		workflowName: "plan-execute",
		phase,
		cwd,
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
		logs: [],
	};
}

afterEach(async () => {
	vi.doUnmock("node:os");
	vi.resetModules();
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("workflow runner kickoff", () => {
	test("plan tools refuse to mutate runs from the wrong session", async () => {
		const home = await tempDir("pi-workflows-runner-session-home");
		const cwd = await tempDir("pi-workflows-runner-session-cwd");
		await writeFile(join(cwd, "plan.md"), "# Plan\n", "utf8");
		const { WorkflowRunner } = await importRunnerWithHome(home);
		const { getRun, saveRun } = await import("../src/store");
		const run = {
			...runRecord("pwf-11111111", cwd, "planning"),
			planningSessionPath: join(cwd, "planning-session.json"),
		};
		await saveRun(run);
		const runner = new WorkflowRunner(
			{
				events: {
					emit: () => {},
					on: () => undefined,
				},
			},
			pathToFileURL(new URL("../index.ts", import.meta.url).pathname).href,
		);
		const wrongCtx = workflowCtx(cwd, join(cwd, "other-session.json"));

		await expect(
			runner.approvePlan("pwf-11111111", "plan.md", undefined, wrongCtx),
		).rejects.toThrow(/planning tools must be called/);
		await expect(
			runner.submitPlan("pwf-11111111", "plan.md", wrongCtx),
		).rejects.toThrow(/planning tools must be called/);
		expect((await getRun("pwf-11111111"))?.phase).toBe("planning");
	});

	test("completion tools require the recorded execution session", async () => {
		const home = await tempDir("pi-workflows-runner-complete-home");
		const cwd = await tempDir("pi-workflows-runner-complete-cwd");
		const { WorkflowRunner } = await importRunnerWithHome(home);
		const { getRun, saveRun } = await import("../src/store");
		const run = {
			...runRecord("pwf-22222222", cwd, "executing"),
			executionSessionPath: join(cwd, "execution-session.json"),
		};
		await saveRun(run);
		const runner = new WorkflowRunner(
			{
				events: {
					emit: () => {},
					on: () => undefined,
				},
			},
			pathToFileURL(new URL("../index.ts", import.meta.url).pathname).href,
		);

		await expect(
			runner.completeRun("pwf-22222222", "completed", "done", workflowCtx(cwd)),
		).rejects.toThrow(/Current session is unavailable/);
		await expect(
			runner.completeRun(
				"pwf-22222222",
				"completed",
				"done",
				workflowCtx(cwd, join(cwd, "other-session.json")),
			),
		).rejects.toThrow(/execution tools must be called/);

		await expect(
			runner.completeRun(
				"pwf-22222222",
				"completed",
				"done",
				workflowCtx(cwd, join(cwd, "execution-session.json")),
			),
		).resolves.toEqual({ text: "Workflow pwf-22222222 marked completed." });
		expect((await getRun("pwf-22222222"))?.phase).toBe("completed");
	});

	test("execute-plan handoff renders supported node metadata fields", async () => {
		const home = await tempDir("pi-workflows-runner-metadata-home");
		const cwd = await tempDir("pi-workflows-runner-metadata-cwd");
		await mkdir(join(cwd, ".pi", "workflows"), { recursive: true });
		await writeFile(
			join(cwd, ".pi", "workflows", "execute-plan.yaml"),
			`name: execute-plan

description: Custom execute-plan metadata test

nodes:
  - id: metadata-node
    prompt: Run with metadata
    model: provider/model
    thinking: high
    modelPolicy: { model: auto, thinking: medium }
    output_format: { type: object }
    output_artifact: result
    timeout: 30
    loop:
      until: done
      max_iterations: 2
`,
			"utf8",
		);
		const planPath = join(cwd, "plan.md");
		await writeFile(planPath, "# Plan\n\n- [ ] Update one file\n", "utf8");
		const { WorkflowRunner } = await importRunnerWithHome(home);
		let kickoff = "";
		const ctx: WorkflowContext = {
			cwd,
			async sendUserMessage(message) {
				kickoff = message;
			},
			async newSession(options) {
				await options.withSession({
					...ctx,
					sessionManager: {
						getSessionFile: () => join(cwd, "execution-session.json"),
					},
					async sendUserMessage(message) {
						kickoff = message;
					},
				});
			},
		};
		const runner = new WorkflowRunner(
			{
				events: {
					emit: () => {},
					on: () => undefined,
				},
				appendEntry: () => {},
			},
			pathToFileURL(new URL("../index.ts", import.meta.url).pathname).href,
		);

		await runner.startWorkflow("execute-plan", "plan.md", ctx);

		expect(kickoff).toContain("### Node: metadata-node");
		expect(kickoff).toContain("model: provider/model");
		expect(kickoff).toContain("thinking: high");
		expect(kickoff).toContain(
			'modelPolicy: {"model":"auto","thinking":"medium"}',
		);
		expect(kickoff).toContain('output_format: {"type":"object"}');
		expect(kickoff).toContain("output_artifact: result");
		expect(kickoff).toContain("timeout: 30");
		expect(kickoff).toContain('loop: {"until":"done","max_iterations":2}');
	});

	test("execute-plan handoff excludes the existing-plan loader node", async () => {
		const home = await tempDir("pi-workflows-runner-home");
		const cwd = await tempDir("pi-workflows-runner-cwd");
		const planPath = join(cwd, "plan.md");
		await writeFile(
			planPath,
			"# Plan\n\n- [ ] Update packages/workflows/src/runner.ts\n",
			"utf8",
		);
		const { WorkflowRunner } = await importRunnerWithHome(home);
		let kickoff = "";
		const ctx: WorkflowContext = {
			cwd,
			async sendUserMessage(message) {
				kickoff = message;
			},
			async newSession(options) {
				await options.setup?.({
					getSessionFile: () => join(cwd, "session.json"),
					appendSessionInfo: () => {},
					appendMessage: () => {},
				});
				await options.withSession({
					...ctx,
					sessionManager: {
						getSessionFile: () => join(cwd, "session.json"),
					},
					async sendUserMessage(message) {
						kickoff = message;
					},
				});
			},
		};
		const pi = {
			events: {
				emit: () => {},
				on: () => undefined,
			},
			appendEntry: () => {},
		};
		const runner = new WorkflowRunner(
			pi,
			pathToFileURL(new URL("../index.ts", import.meta.url).pathname).href,
		);

		await runner.startWorkflow("execute-plan", "plan.md", ctx);

		expect(kickoff).toContain("YAML-derived execution graph");
		expect(kickoff).not.toContain("### Node: load-plan");
		expect(kickoff).not.toContain("command: pi-load-existing-plan");
		expect(kickoff).toContain("### Node: simple-implementation");
	});

	test("continueExecution does not create duplicate sessions for an executing run", async () => {
		const home = await tempDir("pi-workflows-runner-idempotent-home");
		const cwd = await tempDir("pi-workflows-runner-idempotent-cwd");
		const { WorkflowRunner } = await importRunnerWithHome(home);
		const { getRun, saveRun } = await import("../src/store");
		const run = {
			...runRecord("pwf-33333333", cwd, "executing"),
			planPath: "plan.md",
			executionSessionPath: join(cwd, "execution-session.json"),
		};
		await writeFile(join(cwd, "plan.md"), "# Plan\n", "utf8");
		await saveRun(run);
		let newSessionCalls = 0;
		const runner = new WorkflowRunner(
			{
				events: {
					emit: () => {},
					on: () => undefined,
				},
			},
			pathToFileURL(new URL("../index.ts", import.meta.url).pathname).href,
		);
		const ctx: WorkflowContext = {
			cwd,
			async sendUserMessage() {},
			async newSession() {
				newSessionCalls += 1;
			},
		};

		await runner.continueExecution("pwf-33333333", ctx);

		expect(newSessionCalls).toBe(0);
		expect((await getRun("pwf-33333333"))?.executionSessionPath).toBe(
			run.executionSessionPath,
		);
	});

	test("continueExecution fails clearly for executing runs without a recorded session", async () => {
		const home = await tempDir("pi-workflows-runner-idempotent-home");
		const cwd = await tempDir("pi-workflows-runner-idempotent-cwd");
		const { WorkflowRunner } = await importRunnerWithHome(home);
		const { saveRun } = await import("../src/store");
		await saveRun({
			...runRecord("pwf-44444444", cwd, "executing"),
			planPath: "plan.md",
		});
		const runner = new WorkflowRunner(
			{
				events: {
					emit: () => {},
					on: () => undefined,
				},
			},
			pathToFileURL(new URL("../index.ts", import.meta.url).pathname).href,
		);

		await expect(
			runner.continueExecution("pwf-44444444", workflowCtx(cwd)),
		).rejects.toThrow(/refusing to create a duplicate session/);
	});

	test("continueExecution leaves approved runs approved when no execution session file is created", async () => {
		const home = await tempDir("pi-workflows-runner-no-session-home");
		const cwd = await tempDir("pi-workflows-runner-no-session-cwd");
		const planPath = join(cwd, "plan.md");
		await writeFile(planPath, "# Plan\n\n- [ ] Update one file\n", "utf8");
		const { WorkflowRunner } = await importRunnerWithHome(home);
		const { getRun, saveRun } = await import("../src/store");
		await saveRun({
			...runRecord("pwf-55555555", cwd, "approved"),
			planPath: "plan.md",
		});
		const runner = new WorkflowRunner(
			{
				events: {
					emit: () => {},
					on: () => undefined,
				},
			},
			pathToFileURL(new URL("../index.ts", import.meta.url).pathname).href,
		);
		const ctx: WorkflowContext = {
			cwd,
			async sendUserMessage() {},
			async newSession(options) {
				await options.withSession({
					...workflowCtx(cwd),
				});
			},
		};

		await expect(runner.continueExecution("pwf-55555555", ctx)).rejects.toThrow(
			/did not provide a session file/,
		);
		expect((await getRun("pwf-55555555"))?.phase).toBe("approved");
		expect(
			(await getRun("pwf-55555555"))?.executionSessionPath,
		).toBeUndefined();
	});

	test("continueExecution leaves approved runs approved when kickoff send fails", async () => {
		const home = await tempDir("pi-workflows-runner-send-fail-home");
		const cwd = await tempDir("pi-workflows-runner-send-fail-cwd");
		await writeFile(
			join(cwd, "plan.md"),
			"# Plan\n\n- [ ] Update one file\n",
			"utf8",
		);
		const { WorkflowRunner } = await importRunnerWithHome(home);
		const { getRun, saveRun } = await import("../src/store");
		await saveRun({
			...runRecord("pwf-66666666", cwd, "approved"),
			planPath: "plan.md",
		});
		const runner = new WorkflowRunner(
			{
				events: {
					emit: () => {},
					on: () => undefined,
				},
			},
			pathToFileURL(new URL("../index.ts", import.meta.url).pathname).href,
		);
		const ctx: WorkflowContext = {
			cwd,
			async sendUserMessage() {},
			async newSession(options) {
				await options.withSession({
					...workflowCtx(cwd, join(cwd, "execution-session.json")),
					async sendUserMessage() {
						throw new Error("send failed");
					},
				});
			},
		};

		await expect(runner.continueExecution("pwf-66666666", ctx)).rejects.toThrow(
			/send failed/,
		);
		const saved = await getRun("pwf-66666666");
		expect(saved?.phase).toBe("approved");
		expect(saved?.executionSessionPath).toBeUndefined();
	});
});

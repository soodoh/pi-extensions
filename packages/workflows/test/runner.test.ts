import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkflowContext } from "../src/runner";

async function importRunnerWithHome(home: string) {
	vi.resetModules();
	vi.doMock("node:os", () => ({ homedir: () => home }));
	return import("../src/runner");
}

async function tempDir(name: string): Promise<string> {
	const dir = join(tmpdir(), `${name}-${process.pid}-${Date.now()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

afterEach(() => {
	vi.doUnmock("node:os");
	vi.resetModules();
});

describe("workflow runner kickoff", () => {
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
});

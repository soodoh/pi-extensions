import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

async function importConfigLoaderWithHome(home: string) {
	vi.resetModules();
	vi.doMock("node:os", () => ({ homedir: () => home }));
	return import("../src/config-loader");
}

const packageRoot = dirname(
	fileURLToPath(new URL("../package.json", import.meta.url)),
);

async function tempDir(name: string): Promise<string> {
	const dir = join(tmpdir(), `${name}-${process.pid}-${Date.now()}`);
	await mkdir(dir, { recursive: true });
	return dir;
}

afterEach(() => {
	vi.doUnmock("node:os");
	vi.resetModules();
});

describe("workflow config loader", () => {
	test("loads built-in defaults without diagnostics", async () => {
		const home = await tempDir("pi-workflows-config-home");
		const cwd = await tempDir("pi-workflows-config-cwd");
		const { loadWorkflowConfig } = await importConfigLoaderWithHome(home);

		const config = await loadWorkflowConfig(cwd, packageRoot);

		expect(config.diagnostics).toEqual([]);
		expect(config.workflows.map((workflow) => workflow.name).sort()).toEqual([
			"execute-plan",
			"grill-plan-execute",
			"plan-execute",
		]);
		expect(config.commands.length).toBeGreaterThan(0);
	});

	test("drops workflows with missing command references and reports diagnostics", async () => {
		const home = await tempDir("pi-workflows-missing-command-home");
		const cwd = await tempDir("pi-workflows-missing-command-cwd");
		const extensionRoot = await tempDir(
			"pi-workflows-missing-command-extension",
		);
		const workflowDir = join(extensionRoot, "workflows", "defaults");
		await mkdir(workflowDir, { recursive: true });
		await writeFile(
			join(workflowDir, "bad.yaml"),
			`name: bad-workflow

description: Missing command workflow

nodes:
  - id: run
    command: does-not-exist
`,
			"utf8",
		);

		const { loadWorkflowConfig } = await importConfigLoaderWithHome(home);
		const config = await loadWorkflowConfig(cwd, extensionRoot);

		expect(config.workflows).toEqual([]);
		expect(config.diagnostics).toHaveLength(1);
		expect(config.diagnostics[0]).toContain(
			"node run references unknown command does-not-exist",
		);
	});
});

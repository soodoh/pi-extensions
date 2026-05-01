import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

const tempDirs: string[] = [];

async function tempDir(name: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `${name}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.doUnmock("node:os");
	vi.resetModules();
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
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

	test("drops workflows with empty node body strings and reports diagnostics", async () => {
		const home = await tempDir("pi-workflows-empty-node-body-home");
		const cwd = await tempDir("pi-workflows-empty-node-body-cwd");
		const extensionRoot = await tempDir("pi-workflows-empty-node-body-ext");
		const workflowDir = join(extensionRoot, "workflows", "defaults");
		await mkdir(workflowDir, { recursive: true });
		await writeFile(
			join(workflowDir, "empty-command.yaml"),
			`name: empty-command

description: Empty command workflow

nodes:
  - id: run
    command: "   "
`,
			"utf8",
		);
		await writeFile(
			join(workflowDir, "empty-prompt.yaml"),
			`name: empty-prompt

description: Empty prompt workflow

nodes:
  - id: run
    prompt: ""
`,
			"utf8",
		);
		await writeFile(
			join(workflowDir, "empty-bash.yaml"),
			`name: empty-bash

description: Empty bash workflow

nodes:
  - id: run
    bash: "\t"
`,
			"utf8",
		);
		await writeFile(
			join(workflowDir, "empty-script.yaml"),
			`name: empty-script

description: Empty script workflow

nodes:
  - id: run
    script: "   "
`,
			"utf8",
		);

		const { loadWorkflowConfig } = await importConfigLoaderWithHome(home);
		const config = await loadWorkflowConfig(cwd, extensionRoot);

		expect(config.workflows).toEqual([]);
		expect(config.diagnostics).toHaveLength(4);
		expect(config.diagnostics.join("\n")).toContain("empty-command.yaml");
		expect(config.diagnostics.join("\n")).toContain("empty-prompt.yaml");
		expect(config.diagnostics.join("\n")).toContain("empty-bash.yaml");
		expect(config.diagnostics.join("\n")).toContain("empty-script.yaml");
		expect(config.diagnostics.join("\n")).toContain("workflow schema");
	});

	test("drops workflows with cyclic depends_on and reports diagnostics", async () => {
		const home = await tempDir("pi-workflows-cycle-home");
		const cwd = await tempDir("pi-workflows-cycle-cwd");
		const extensionRoot = await tempDir("pi-workflows-cycle-extension");
		const workflowDir = join(extensionRoot, "workflows", "defaults");
		const commandDir = join(extensionRoot, "commands", "defaults");
		await mkdir(workflowDir, { recursive: true });
		await mkdir(commandDir, { recursive: true });
		await writeFile(
			join(commandDir, "known.md"),
			"Run known command\n",
			"utf8",
		);
		await writeFile(
			join(workflowDir, "cycle.yaml"),
			`name: cycle

description: Cyclic workflow

nodes:
  - id: first
    depends_on: [second]
    command: known
  - id: second
    depends_on: [third]
    command: known
  - id: third
    depends_on: [first]
    command: known
`,
			"utf8",
		);
		await writeFile(
			join(workflowDir, "reciprocal.yaml"),
			`name: reciprocal

description: Reciprocal workflow

nodes:
  - id: left
    depends_on: [right]
    command: known
  - id: right
    depends_on: [left]
    command: known
`,
			"utf8",
		);

		const { loadWorkflowConfig } = await importConfigLoaderWithHome(home);
		const config = await loadWorkflowConfig(cwd, extensionRoot);

		expect(config.workflows).toEqual([]);
		expect(config.diagnostics).toHaveLength(2);
		expect(config.diagnostics.join("\n")).toContain(
			"workflow dependency cycle",
		);
		expect(config.diagnostics.join("\n")).toContain(
			"first -> second -> third -> first",
		);
		expect(config.diagnostics.join("\n")).toContain("left -> right -> left");
	});

	test("drops workflows with unsupported modelPolicy stages", async () => {
		const home = await tempDir("pi-workflows-policy-home");
		const cwd = await tempDir("pi-workflows-policy-cwd");
		const extensionRoot = await tempDir("pi-workflows-policy-extension");
		const workflowDir = join(extensionRoot, "workflows", "defaults");
		const commandDir = join(extensionRoot, "commands", "defaults");
		await mkdir(workflowDir, { recursive: true });
		await mkdir(commandDir, { recursive: true });
		await writeFile(
			join(commandDir, "known.md"),
			"Run known command\n",
			"utf8",
		);
		await writeFile(
			join(workflowDir, "reviewer-policy.yaml"),
			`name: reviewer-policy

description: Unsupported policy stage

modelPolicy:
  default: { model: inherit }
  reviewer: { model: auto }

nodes:
  - id: run
    command: known
`,
			"utf8",
		);

		const { loadWorkflowConfig } = await importConfigLoaderWithHome(home);
		const config = await loadWorkflowConfig(cwd, extensionRoot);

		expect(config.workflows).toEqual([]);
		expect(config.diagnostics).toHaveLength(1);
		expect(config.diagnostics[0]).toContain("unsupported stage keys: reviewer");
	});

	test("drops workflows with unknown root, node, and nested keys", async () => {
		const home = await tempDir("pi-workflows-unknown-keys-home");
		const cwd = await tempDir("pi-workflows-unknown-keys-cwd");
		const extensionRoot = await tempDir("pi-workflows-unknown-keys-extension");
		const workflowDir = join(extensionRoot, "workflows", "defaults");
		const commandDir = join(extensionRoot, "commands", "defaults");
		await mkdir(workflowDir, { recursive: true });
		await mkdir(commandDir, { recursive: true });
		await writeFile(
			join(commandDir, "known.md"),
			"Run known command\n",
			"utf8",
		);
		await writeFile(
			join(workflowDir, "unknown-root.yaml"),
			`name: unknown-root

description: Unknown root key
unknownRoot: true

nodes:
  - id: run
    command: known
`,
			"utf8",
		);
		await writeFile(
			join(workflowDir, "unknown-node.yaml"),
			`name: unknown-node

description: Unknown node key

nodes:
  - id: run
    command: known
    dependsOn: [other]
`,
			"utf8",
		);
		await writeFile(
			join(workflowDir, "unknown-nested.yaml"),
			`name: unknown-nested

description: Unknown nested key

modelPolicy:
  default:
    model: auto
    unexpected: true

nodes:
  - id: run
    command: known
`,
			"utf8",
		);

		const { loadWorkflowConfig } = await importConfigLoaderWithHome(home);
		const config = await loadWorkflowConfig(cwd, extensionRoot);

		expect(config.workflows).toEqual([]);
		expect(config.diagnostics).toHaveLength(3);
		expect(config.diagnostics.join("\n")).toContain("unknown-root.yaml");
		expect(config.diagnostics.join("\n")).toContain("unknown-node.yaml");
		expect(config.diagnostics.join("\n")).toContain("unknown-nested.yaml");
		expect(config.diagnostics.join("\n")).toContain("workflow schema");
	});

	test("skips oversized workflow and command files with diagnostics", async () => {
		const home = await tempDir("pi-workflows-oversized-home");
		const cwd = await tempDir("pi-workflows-oversized-cwd");
		const extensionRoot = await tempDir("pi-workflows-oversized-extension");
		const workflowDir = join(extensionRoot, "workflows", "defaults");
		const commandDir = join(extensionRoot, "commands", "defaults");
		await mkdir(workflowDir, { recursive: true });
		await mkdir(commandDir, { recursive: true });
		await writeFile(
			join(workflowDir, "large.yaml"),
			`name: large\n\ndescription: ${"a".repeat(1024 * 1024)}\n\nnodes:\n  - id: run\n    command: large\n`,
			"utf8",
		);
		await writeFile(
			join(commandDir, "large.md"),
			"a".repeat(1024 * 1024 + 1),
			"utf8",
		);

		const { loadWorkflowConfig } = await importConfigLoaderWithHome(home);
		const config = await loadWorkflowConfig(cwd, extensionRoot);

		expect(config.workflows).toEqual([]);
		expect(config.commands).toEqual([]);
		expect(config.diagnostics.join("\n")).toContain("large.yaml");
		expect(config.diagnostics.join("\n")).toContain("large.md");
		expect(config.diagnostics.join("\n")).toContain("too large");
	});

	test("skips project-local config directories that resolve outside cwd", async () => {
		const home = await tempDir("pi-workflows-symlink-home");
		const cwd = await tempDir("pi-workflows-symlink-cwd");
		const outside = await tempDir("pi-workflows-symlink-outside");
		const extensionRoot = await tempDir("pi-workflows-symlink-extension");
		await mkdir(join(outside, "workflows"), { recursive: true });
		await mkdir(join(outside, "workflow-commands"), { recursive: true });
		await writeFile(
			join(outside, "workflow-commands", "known.md"),
			"Run outside command\n",
			"utf8",
		);
		await writeFile(
			join(outside, "workflows", "outside.yaml"),
			`name: outside

	description: Outside project-local workflow

	nodes:
	  - id: run
	    command: known
	`,
			"utf8",
		);
		await symlink(outside, join(cwd, ".pi"));

		const { loadWorkflowConfig } = await importConfigLoaderWithHome(home);
		const config = await loadWorkflowConfig(cwd, extensionRoot);

		expect(config.workflows.map((workflow) => workflow.name)).not.toContain(
			"outside",
		);
		expect(config.commands.map((command) => command.name)).not.toContain(
			"known",
		);
		expect(config.diagnostics.join("\n")).toContain("outside workflow cwd");
	});
});

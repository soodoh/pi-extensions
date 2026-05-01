import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkflowRunRecord } from "../src/workflow-types";

async function importStoreWithHome(home: string) {
	vi.resetModules();
	vi.doMock("node:os", () => ({ homedir: () => home }));
	return import("../src/store");
}

const tempDirs: string[] = [];

async function tempHome(name: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `${name}-`));
	tempDirs.push(dir);
	return dir;
}

function runRecord(id: string, updatedAt: string): WorkflowRunRecord {
	return {
		id,
		workflowName: "plan-execute",
		phase: "created",
		cwd: "/repo",
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt,
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

describe("workflow run store", () => {
	test("filters invalid legacy and per-run records and tolerates malformed files", async () => {
		const home = await tempHome("pi-workflows-store-home");
		const legacyPath = join(home, ".pi", "agent", "workflow-runs.json");
		const runsDir = join(home, ".pi", "agent", "workflow-runs");
		await mkdir(runsDir, { recursive: true });
		await writeFile(
			legacyPath,
			JSON.stringify({
				runs: [
					runRecord("pwf-11111111", "2026-05-01T00:00:00.000Z"),
					{ id: "../escape", logs: [] },
				],
			}),
			"utf8",
		);
		await writeFile(
			join(runsDir, "pwf-22222222.json"),
			JSON.stringify(runRecord("pwf-22222222", "2026-05-02T00:00:00.000Z")),
			"utf8",
		);
		await writeFile(join(runsDir, "pwf-33333333.json"), "{", "utf8");
		await writeFile(
			join(runsDir, "..escape.json"),
			JSON.stringify(runRecord("pwf-33333333", "2026-05-03T00:00:00.000Z")),
			"utf8",
		);

		const { listRuns } = await importStoreWithHome(home);
		const runs = await listRuns();

		expect(runs.map((run) => run.id)).toEqual(["pwf-22222222", "pwf-11111111"]);
	});

	test("writes workflow run state with private permissions", async () => {
		const home = await tempHome("pi-workflows-store-private-home");
		const { saveRun, workflowRunStorePath } = await importStoreWithHome(home);
		await saveRun(runRecord("pwf-44444444", "2026-05-01T00:00:00.000Z"));

		const dirMode = (await stat(workflowRunStorePath)).mode & 0o777;
		const fileMode =
			(await stat(join(workflowRunStorePath, "pwf-44444444.json"))).mode &
			0o777;
		expect(dirMode).toBe(0o700);
		expect(fileMode).toBe(0o600);
	});

	test("rejects traversal run ids before reading or writing paths", async () => {
		const home = await tempHome("pi-workflows-store-traversal-home");
		const { getRun, saveRun } = await importStoreWithHome(home);

		await expect(getRun("../pwf-11111111")).rejects.toThrow(
			/Invalid workflow run id/,
		);
		await expect(
			saveRun(runRecord("pwf-../bad", "2026-05-01T00:00:00.000Z")),
		).rejects.toThrow(/Invalid workflow run id/);
	});
});

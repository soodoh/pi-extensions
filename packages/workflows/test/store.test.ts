import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { WorkflowRunRecord } from "../src/workflow-types";

async function importStoreWithHome(home: string) {
	vi.resetModules();
	vi.doMock("node:os", () => ({ homedir: () => home }));
	return import("../src/store");
}

async function tempHome(name: string): Promise<string> {
	const dir = join(tmpdir(), `${name}-${process.pid}-${Date.now()}`);
	await mkdir(dir, { recursive: true });
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

afterEach(() => {
	vi.doUnmock("node:os");
	vi.resetModules();
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

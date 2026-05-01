import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
	ensureInsideCwd,
	ensureRealPathInsideCwd,
	extensionDir,
	homePath,
	isValidWorkflowRunId,
	makeRunId,
	normalizeWorkflowRunId,
	nowIso,
	readTextIfExists,
	sha256,
	writeJson,
} from "./utils";

const tempDirs: string[] = [];

async function tempDir(name: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `${name}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

describe("workflow utils", () => {
	test("formats ids, timestamps, hashes, and home paths", () => {
		const runId = makeRunId();
		expect(runId).toMatch(/^pwf-[a-f0-9]{32}$/);
		expect(isValidWorkflowRunId(runId)).toBe(true);
		expect(isValidWorkflowRunId("pwf-11111111")).toBe(true);
		expect(normalizeWorkflowRunId(` ${runId} `)).toBe(runId);
		expect(isValidWorkflowRunId("../pwf-11111111")).toBe(false);
		expect(() => normalizeWorkflowRunId("pwf-../bad")).toThrow(
			/Invalid workflow run id/,
		);
		expect(Date.parse(nowIso())).not.toBeNaN();
		expect(sha256("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(homePath(".pi", "agent")).toBe(join(homedir(), ".pi", "agent"));
	});

	test("extensionDir decodes import.meta.url paths", () => {
		const dir = join(tmpdir(), "pi workflow utils space");
		const fileUrl = pathToFileURL(join(dir, "index.ts")).href;
		expect(extensionDir(fileUrl)).toBe(dir);
	});

	test("ensureInsideCwd rejects lexical escapes", () => {
		expect(() => ensureInsideCwd("/repo", "../outside.md")).toThrow(
			/inside cwd/,
		);
		expect(ensureInsideCwd("/repo", "plans/plan.md")).toBe(
			"/repo/plans/plan.md",
		);
	});

	test("ensureRealPathInsideCwd rejects symlinks that escape cwd", async () => {
		const root = await tempDir("pi-workflows-root");
		const outside = await tempDir("pi-workflows-outside");
		await writeFile(join(outside, "plan.md"), "# Plan\n", "utf8");
		await symlink(join(outside, "plan.md"), join(root, "linked-plan.md"));

		await expect(
			ensureRealPathInsideCwd(root, "linked-plan.md"),
		).rejects.toThrow(/inside cwd/);
	});

	test("ensureRealPathInsideCwd returns the checked real path inside cwd", async () => {
		const root = await tempDir("pi-workflows-root");
		await mkdir(join(root, "plans"), { recursive: true });
		const realPlan = join(root, "plans", "plan.md");
		await writeFile(realPlan, "# Plan\n", "utf8");
		await symlink(realPlan, join(root, "linked-plan.md"));

		await expect(ensureRealPathInsideCwd(root, "linked-plan.md")).resolves.toBe(
			await realpath(realPlan),
		);
	});

	test("readTextIfExists and writeJson handle optional files", async () => {
		const root = await tempDir("pi-workflows-json");
		const file = join(root, "nested", "data.json");
		await expect(readTextIfExists(file)).resolves.toBeUndefined();

		await writeJson(file, { ok: true });

		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ok: true });
		await expect(readTextIfExists(file)).resolves.toContain('"ok": true');
	});
});

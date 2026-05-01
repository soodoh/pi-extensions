import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
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

describe("workflow utils", () => {
	test("formats ids, timestamps, hashes, and home paths", () => {
		const runId = makeRunId();
		expect(runId).toMatch(/^pwf-[a-f0-9]{8}$/);
		expect(isValidWorkflowRunId(runId)).toBe(true);
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
		const root = join(
			tmpdir(),
			`pi-workflows-root-${process.pid}-${Date.now()}`,
		);
		const outside = join(
			tmpdir(),
			`pi-workflows-outside-${process.pid}-${Date.now()}`,
		);
		await mkdir(root, { recursive: true });
		await mkdir(outside, { recursive: true });
		await writeFile(join(outside, "plan.md"), "# Plan\n", "utf8");
		await symlink(join(outside, "plan.md"), join(root, "linked-plan.md"));

		await expect(
			ensureRealPathInsideCwd(root, "linked-plan.md"),
		).rejects.toThrow(/inside cwd/);
	});

	test("ensureRealPathInsideCwd allows real files inside cwd", async () => {
		const root = join(
			tmpdir(),
			`pi-workflows-root-${process.pid}-${Date.now()}-ok`,
		);
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "plan.md"), "# Plan\n", "utf8");

		await expect(ensureRealPathInsideCwd(root, "plan.md")).resolves.toBe(
			join(root, "plan.md"),
		);
	});

	test("readTextIfExists and writeJson handle optional files", async () => {
		const root = join(
			tmpdir(),
			`pi-workflows-json-${process.pid}-${Date.now()}`,
		);
		const file = join(root, "nested", "data.json");
		await expect(readTextIfExists(file)).resolves.toBeUndefined();

		await writeJson(file, { ok: true });

		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ok: true });
		await expect(readTextIfExists(file)).resolves.toContain('"ok": true');
	});
});

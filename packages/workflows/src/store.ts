import { existsSync } from "node:fs";
import { open, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
	homePath,
	isValidWorkflowRunId,
	normalizeWorkflowRunId,
	nowIso,
	writeJson,
} from "./utils";
import type { WorkflowRunRecord } from "./workflow-types";

const LEGACY_STORE_PATH = homePath(".pi", "agent", "workflow-runs.json");
const RUNS_DIR = homePath(".pi", "agent", "workflow-runs");
const RUN_LOCK_RETRY_MS = 10;
const RUN_LOCK_MAX_WAIT_MS = 30_000;
const RUN_LOCK_STALE_MS = 5 * 60_000;

type StoreFile = { runs: WorkflowRunRecord[] };

const workflowRunRecordSchema = Type.Object({
	id: Type.String(),
	workflowName: Type.String(),
	phase: Type.Union([
		Type.Literal("created"),
		Type.Literal("planning"),
		Type.Literal("reviewing-plan"),
		Type.Literal("approved"),
		Type.Literal("executing"),
		Type.Literal("paused"),
		Type.Literal("completed"),
		Type.Literal("failed"),
	]),
	cwd: Type.String(),
	createdAt: Type.String(),
	updatedAt: Type.String(),
	request: Type.Optional(Type.String()),
	planPath: Type.Optional(Type.String()),
	planContentHash: Type.Optional(Type.String()),
	approvedPlanContent: Type.Optional(Type.String()),
	approvalNotes: Type.Optional(Type.String()),
	planningSessionPath: Type.Optional(Type.String()),
	executionSessionPath: Type.Optional(Type.String()),
	selectedCommandPath: Type.Optional(Type.String()),
	selectedComplexity: Type.Optional(
		Type.Union([
			Type.Literal("simple"),
			Type.Literal("medium"),
			Type.Literal("complex"),
		]),
	),
	logs: Type.Array(Type.String()),
});
const legacyStoreSchema = Type.Object({ runs: Type.Array(Type.Unknown()) });

function isWorkflowRunRecord(value: unknown): value is WorkflowRunRecord {
	return (
		Value.Check(workflowRunRecordSchema, value) &&
		isValidWorkflowRunId(value.id)
	);
}

function runFilePath(id: string): string {
	return join(RUNS_DIR, `${normalizeWorkflowRunId(id)}.json`);
}

function runLockPath(id: string, name: string): string {
	return join(RUNS_DIR, `${normalizeWorkflowRunId(id)}.${name}.lock`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseLockPid(raw: string): number | undefined {
	const value = Number(raw.trim());
	return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isErrnoException(error) && error.code === "ESRCH") return false;
		return true;
	}
}

async function removeStaleRunLock(lockPath: string): Promise<boolean> {
	let raw = "";
	let lockAgeMs = 0;
	try {
		const [contents, metadata] = await Promise.all([
			readFile(lockPath, "utf8"),
			stat(lockPath),
		]);
		raw = contents;
		lockAgeMs = Date.now() - metadata.mtimeMs;
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") return true;
		return false;
	}

	const pid = parseLockPid(raw);
	const deadProcess = pid !== undefined && !isProcessAlive(pid);
	const tooOld = lockAgeMs > RUN_LOCK_STALE_MS;
	if (!deadProcess && !tooOld) return false;

	try {
		await rm(lockPath, { force: true });
		return true;
	} catch {
		return false;
	}
}

function runLockWaitError(lockPath: string, cause: unknown): Error {
	return new Error(
		`Timed out waiting for workflow run lock ${lockPath}: ${errorMessage(cause)}. If no workflow continuation is running, remove this lock file manually and retry.`,
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLegacyStore(): Promise<StoreFile> {
	if (!existsSync(LEGACY_STORE_PATH)) return { runs: [] };
	try {
		const parsed: unknown = JSON.parse(
			await readFile(LEGACY_STORE_PATH, "utf8"),
		);
		if (!Value.Check(legacyStoreSchema, parsed)) return { runs: [] };
		return { runs: parsed.runs.filter(isWorkflowRunRecord) };
	} catch {
		return { runs: [] };
	}
}

async function readRunFile(id: string): Promise<WorkflowRunRecord | undefined> {
	const runId = normalizeWorkflowRunId(id);
	const path = runFilePath(runId);
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isWorkflowRunRecord(parsed) && parsed.id === runId
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

async function readRunFiles(): Promise<WorkflowRunRecord[]> {
	if (!existsSync(RUNS_DIR)) return [];
	const files = await readdir(RUNS_DIR, { withFileTypes: true });
	const runs = await Promise.all(
		files
			.map((file) => basename(file.name, ".json"))
			.filter(
				(id, index) =>
					files[index].isFile() &&
					extname(files[index].name).toLowerCase() === ".json" &&
					isValidWorkflowRunId(id),
			)
			.map((id) => readRunFile(id)),
	);
	return runs.filter((run): run is WorkflowRunRecord => Boolean(run));
}

export async function listRuns(): Promise<WorkflowRunRecord[]> {
	const byId = new Map<string, WorkflowRunRecord>();
	for (const run of (await readLegacyStore()).runs) byId.set(run.id, run);
	for (const run of await readRunFiles()) byId.set(run.id, run);
	return [...byId.values()].sort((a, b) =>
		b.updatedAt.localeCompare(a.updatedAt),
	);
}

export async function getRun(
	id: string,
): Promise<WorkflowRunRecord | undefined> {
	const runId = normalizeWorkflowRunId(id);
	return (
		(await readRunFile(runId)) ??
		(await readLegacyStore()).runs.find((run) => run.id === runId)
	);
}

export async function saveRun(run: WorkflowRunRecord): Promise<void> {
	const runId = normalizeWorkflowRunId(run.id);
	run.updatedAt = nowIso();
	await writeJson(runFilePath(runId), run);
}

export async function appendRunLog(id: string, message: string): Promise<void> {
	const run = await getRun(id);
	if (!run) return;
	run.logs.push(`${nowIso()} ${message}`);
	await saveRun(run);
}

export async function withRunLock<T>(
	id: string,
	name: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lockPath = runLockPath(id, name);
	const deadline = Date.now() + RUN_LOCK_MAX_WAIT_MS;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	let lastWaitCause: unknown = "lock is held by another process";
	while (!handle) {
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${process.pid}\n`, "utf8");
		} catch (error) {
			if (isErrnoException(error) && error.code === "EEXIST") {
				lastWaitCause = error;
				if (await removeStaleRunLock(lockPath)) continue;
				if (Date.now() >= deadline) {
					throw runLockWaitError(lockPath, lastWaitCause);
				}
				await sleep(
					Math.min(RUN_LOCK_RETRY_MS, Math.max(0, deadline - Date.now())),
				);
				continue;
			}
			throw error;
		}
	}

	try {
		return await fn();
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
	}
}

export const workflowRunStorePath = RUNS_DIR;

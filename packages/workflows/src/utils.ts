import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
	chmod,
	mkdir,
	readFile,
	realpath,
	rename,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_RUN_ID_PATTERN =
	/^pwf-(?:[a-f0-9]{8}|[a-f0-9]{24}|[a-f0-9]{32})$/;

export function isValidWorkflowRunId(id: string): boolean {
	return WORKFLOW_RUN_ID_PATTERN.test(id);
}

export function normalizeWorkflowRunId(id: string): string {
	const normalized = id.trim();
	if (!isValidWorkflowRunId(normalized)) {
		throw new Error(`Invalid workflow run id: ${id}`);
	}
	return normalized;
}

export function makeRunId(): string {
	return `pwf-${randomBytes(16).toString("hex")}`;
}
export function nowIso(): string {
	return new Date().toISOString();
}
export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
export function homePath(...parts: string[]): string {
	return join(homedir(), ...parts);
}
export function relativePathEscapesRoot(relativePath: string): boolean {
	return (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	);
}
export function ensureInsideCwd(cwd: string, path: string): string {
	const full = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
	const root = resolve(cwd);
	const relativePath = relative(root, full);
	if (relativePathEscapesRoot(relativePath))
		throw new Error(`Path must be inside cwd: ${path}`);
	return full;
}
export async function ensureRealPathInsideCwd(
	cwd: string,
	path: string,
): Promise<string> {
	const full = ensureInsideCwd(cwd, path);
	const [realRoot, realFull] = await Promise.all([
		realpath(cwd),
		realpath(full),
	]);
	const relativePath = relative(realRoot, realFull);
	if (relativePathEscapesRoot(relativePath))
		throw new Error(`Path must be inside cwd: ${path}`);
	return realFull;
}
export async function readTextIfExists(
	path: string,
): Promise<string | undefined> {
	if (!existsSync(path)) return undefined;
	return readFile(path, "utf8");
}
async function chmodIfPossible(path: string, mode: number): Promise<void> {
	try {
		await chmod(path, mode);
	} catch {
		// Best effort: chmod may be unsupported on some filesystems.
	}
}

export async function writeJson(path: string, data: unknown): Promise<void> {
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmodIfPossible(directory, 0o700);
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await chmodIfPossible(tempPath, 0o600);
	await rename(tempPath, path);
	await chmodIfPossible(path, 0o600);
}
export function extensionDir(importMetaUrl: string): string {
	return dirname(fileURLToPath(importMetaUrl));
}

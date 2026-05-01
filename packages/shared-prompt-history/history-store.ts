import { appendFile, chmod, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HISTORY_FILE_NAME = "prompt-history.jsonl";
const TAIL_READ_CHUNK_SIZE = 8192;
const lastPersistedPromptByPath = new Map<string, string>();

export interface PromptHistoryPathOptions {
	home?: string;
}

export function getPromptHistoryPath(
	options: PromptHistoryPathOptions = {},
): string {
	const home = options.home ?? homedir();
	return join(home, ".local", "state", "pi", HISTORY_FILE_NAME);
}

function parsePromptLine(line: string): string | undefined {
	if (!line.trim()) return undefined;
	try {
		const entry: unknown = JSON.parse(line);
		const prompt = entry ? Reflect.get(Object(entry), "prompt") : undefined;
		return typeof prompt === "string" && prompt.trim() ? prompt : undefined;
	} catch {
		return undefined;
	}
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof Error && Reflect.get(error, "code") === "ENOENT";
}

async function chmodIfPossible(path: string, mode: number): Promise<void> {
	try {
		await chmod(path, mode);
	} catch {
		// Best effort: chmod may be unsupported on some filesystems.
	}
}

async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	await chmodIfPossible(path, 0o700);
}

async function readLastPrompt(
	historyPath: string,
): Promise<string | undefined> {
	let file: Awaited<ReturnType<typeof open>>;
	try {
		file = await open(historyPath, "r");
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw error;
	}

	try {
		const { size } = await file.stat();
		let position = size;
		let text = "";
		while (position > 0) {
			const length = Math.min(TAIL_READ_CHUNK_SIZE, position);
			position -= length;
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await file.read(buffer, 0, length, position);
			text = `${buffer.subarray(0, bytesRead).toString("utf8")}${text}`;
			const lines = text.split("\n");
			const completeLines = position === 0 ? lines : lines.slice(1);
			for (let index = completeLines.length - 1; index >= 0; index -= 1) {
				const prompt = parsePromptLine(completeLines[index]);
				if (prompt) return prompt;
			}
			text = position === 0 ? "" : (lines[0] ?? "");
		}
		return undefined;
	} finally {
		await file.close();
	}
}

export async function readPromptHistory(
	historyPath = getPromptHistoryPath(),
): Promise<string[]> {
	let contents: string;

	try {
		contents = await readFile(historyPath, "utf8");
	} catch (error) {
		if (isNotFoundError(error)) return [];
		throw error;
	}

	const prompts: string[] = [];

	for (const line of contents.split("\n")) {
		const parsed = parsePromptLine(line);
		if (parsed) prompts.push(parsed);
	}

	const lastPrompt = prompts.at(-1);
	if (lastPrompt) lastPersistedPromptByPath.set(historyPath, lastPrompt);
	return prompts;
}

export interface AppendPromptOptions {
	lastPersistedPrompt?: string;
}

export async function appendPrompt(
	prompt: string,
	historyPath = getPromptHistoryPath(),
	options: AppendPromptOptions = {},
): Promise<boolean> {
	const trimmed = prompt.trim();
	if (!trimmed) return false;

	const knownLastPrompt =
		options.lastPersistedPrompt ?? lastPersistedPromptByPath.get(historyPath);
	if (knownLastPrompt === trimmed) return false;

	if (knownLastPrompt === undefined) {
		const lastPrompt = await readLastPrompt(historyPath);
		if (lastPrompt) lastPersistedPromptByPath.set(historyPath, lastPrompt);
		if (lastPrompt === trimmed) return false;
	}

	await ensurePrivateDirectory(dirname(historyPath));
	await appendFile(
		historyPath,
		`${JSON.stringify({ ts: new Date().toISOString(), prompt: trimmed })}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	await chmodIfPossible(historyPath, 0o600);
	lastPersistedPromptByPath.set(historyPath, trimmed);
	return true;
}

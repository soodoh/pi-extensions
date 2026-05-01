import type { Dirent } from "node:fs";
import { appendFile, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type ExtensionAPI = {
	getSessionName(): string | undefined;
	setSessionName(name: string): void;
	on(
		eventName: "turn_end",
		handler: (
			event: { turnIndex: number },
			ctx: ExtensionContext,
		) => void | Promise<void>,
	): void;
	on(
		eventName: "session_start",
		handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
	): void;
};

type ExtensionContext = {
	sessionManager: {
		getBranch(): unknown[];
	};
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

type ShouldNameAfterTurnInput = {
	hasSessionName: boolean;
	skillName?: string;
	turnIndex: number;
};

const LEADING_SKILL_RE = /^\s*<skill\b([^>]*)>[\s\S]*?<\/skill>\s*/i;
const SKILL_NAME_RE = /\bname=(?:"([^"]+)"|'([^']+)')/i;
const DEFAULT_MAX_TITLE_LENGTH = 72;
const SESSION_INFO_TYPE = "session_info";
const DEFAULT_BACKFILL_LIMITS = {
	maxFiles: 200,
	maxDirectories: 500,
	maxFileBytes: 256 * 1024,
	maxElapsedMs: 2000,
};

type BackfillLimits = typeof DEFAULT_BACKFILL_LIMITS;

let didBackfillExistingSessions = false;

export const extractSkillName = (text: string): string | undefined => {
	const skillMatch = text.match(/^\s*<skill\b([^>]*)>/i);
	if (!skillMatch) {
		return undefined;
	}

	const nameMatch = skillMatch[1]?.match(SKILL_NAME_RE);
	return nameMatch?.[1] ?? nameMatch?.[2];
};

export const extractUserRequest = (text: string): string => {
	return text.replace(LEADING_SKILL_RE, "").trim();
};

const compactWhitespace = (text: string): string =>
	text.replace(/\s+/g, " ").trim();

const truncateTitle = (title: string, maxLength: number): string => {
	if (title.length <= maxLength) return title;
	if (maxLength <= 1) return "…";
	return `${title.slice(0, maxLength - 1).trimEnd()}…`;
};

export const makeSessionTitle = (
	skillName: string,
	request: string,
	maxLength = DEFAULT_MAX_TITLE_LENGTH,
): string => {
	const cleanRequest = compactWhitespace(request);
	if (!cleanRequest) {
		return truncateTitle(`${skillName} skill session`, maxLength);
	}

	const prefix = `${skillName}: `;
	return truncateTitle(`${prefix}${cleanRequest}`, maxLength);
};

export const shouldNameAfterTurn = ({
	hasSessionName,
	skillName,
	turnIndex,
}: ShouldNameAfterTurnInput): boolean => {
	return !hasSessionName && Boolean(skillName) && turnIndex === 0;
};

const extractTextContent = (content: unknown): string => {
	if (typeof content === "string") {
		return content;
	}

	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.filter((part): part is { type: string; text: string } => {
			return (
				Boolean(part) &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
			);
		})
		.map((part) => part.text)
		.join("\n");
};

const getLatestSessionName = (entries: unknown[]): string | undefined => {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") {
			continue;
		}

		const maybeInfo = entry as { type?: unknown; name?: unknown };
		if (maybeInfo.type === SESSION_INFO_TYPE) {
			return typeof maybeInfo.name === "string"
				? maybeInfo.name.trim() || undefined
				: undefined;
		}
	}

	return undefined;
};

const getEntryId = (entry: unknown): string | null => {
	if (!entry || typeof entry !== "object") {
		return null;
	}

	const id = (entry as { id?: unknown }).id;
	return typeof id === "string" ? id : null;
};

const makeEntryId = (entries: unknown[]): string => {
	const existingIds = new Set(
		entries.map(getEntryId).filter((id): id is string => Boolean(id)),
	);
	let id = "";
	do {
		id = Math.floor(Math.random() * 0xffffffff)
			.toString(16)
			.padStart(8, "0")
			.slice(0, 8);
	} while (existingIds.has(id));

	return id;
};

const parseJsonlEntries = (content: string): unknown[] => {
	return content
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as unknown);
};

const getFirstUserMessageText = (
	entries: SessionEntry[],
): string | undefined => {
	const firstUserEntry = entries.find(
		(entry) => entry.type === "message" && entry.message?.role === "user",
	);
	if (!firstUserEntry) {
		return undefined;
	}

	const text = extractTextContent(firstUserEntry.message?.content).trim();
	return text || undefined;
};

export const backfillSkillSessionNameInFile = async (
	sessionPath: string,
	limits: Pick<BackfillLimits, "maxFileBytes"> = DEFAULT_BACKFILL_LIMITS,
): Promise<boolean> => {
	const fileStat = await stat(sessionPath);
	if (!fileStat.isFile() || fileStat.size > limits.maxFileBytes) return false;
	const content = await readFile(sessionPath, "utf8");
	const entries = parseJsonlEntries(content);
	if (getLatestSessionName(entries)) {
		return false;
	}

	const firstUserText = getFirstUserMessageText(entries as SessionEntry[]);
	if (!firstUserText) {
		return false;
	}

	const skillName = extractSkillName(firstUserText);
	if (!skillName) {
		return false;
	}

	const lastEntry = entries.at(-1);
	const sessionInfo = {
		type: SESSION_INFO_TYPE,
		id: makeEntryId(entries),
		parentId: getEntryId(lastEntry),
		timestamp: new Date().toISOString(),
		name: makeSessionTitle(skillName, extractUserRequest(firstUserText)),
	};

	const suffix = content.endsWith("\n") ? "" : "\n";
	await appendFile(sessionPath, `${suffix}${JSON.stringify(sessionInfo)}\n`, {
		flag: "a",
	});
	return true;
};

const backfillDeadline = (startedAt: number, limits: BackfillLimits): number =>
	startedAt + limits.maxElapsedMs;

const hasBackfillTimeRemaining = (deadline: number): boolean =>
	Date.now() <= deadline;

const findSessionFiles = async (
	directory: string,
	limits: BackfillLimits,
	deadline: number,
): Promise<string[]> => {
	const files: string[] = [];
	const pendingDirectories = [directory];
	let visitedDirectories = 0;

	while (
		pendingDirectories.length > 0 &&
		files.length < limits.maxFiles &&
		visitedDirectories < limits.maxDirectories &&
		hasBackfillTimeRemaining(deadline)
	) {
		const current = pendingDirectories.shift();
		if (!current) break;
		visitedDirectories += 1;
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (
				!hasBackfillTimeRemaining(deadline) ||
				files.length >= limits.maxFiles
			) {
				break;
			}
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				if (
					visitedDirectories + pendingDirectories.length <
					limits.maxDirectories
				) {
					pendingDirectories.push(fullPath);
				}
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
		}
	}

	return files;
};

export const backfillSkillSessionNames = async (
	sessionsDir = join(homedir(), ".pi", "agent", "sessions"),
	limits: BackfillLimits = DEFAULT_BACKFILL_LIMITS,
): Promise<number> => {
	const deadline = backfillDeadline(Date.now(), limits);
	const sessionFiles = await findSessionFiles(sessionsDir, limits, deadline);
	let changedCount = 0;

	for (const sessionFile of sessionFiles) {
		if (!hasBackfillTimeRemaining(deadline)) break;
		try {
			if (await backfillSkillSessionNameInFile(sessionFile, limits)) {
				changedCount++;
			}
		} catch {
			// Ignore malformed or concurrently modified session files.
		}
	}

	return changedCount;
};

function scheduleHistoricalBackfill(): void {
	if (didBackfillExistingSessions) return;
	didBackfillExistingSessions = true;
	setTimeout(() => {
		void backfillSkillSessionNames().catch(() => undefined);
	}, 0);
}

const maybeNameSkillSession = (
	pi: ExtensionAPI,
	entries: SessionEntry[],
): boolean => {
	if (pi.getSessionName()) {
		return false;
	}

	const firstUserText = getFirstUserMessageText(entries);
	if (!firstUserText) {
		return false;
	}

	const skillName = extractSkillName(firstUserText);
	if (!skillName) {
		return false;
	}

	pi.setSessionName(
		makeSessionTitle(skillName, extractUserRequest(firstUserText)),
	);
	return true;
};

export default function (pi: ExtensionAPI) {
	pi.on("turn_end", async (event, ctx) => {
		const firstUserText = getFirstUserMessageText(
			ctx.sessionManager.getBranch() as SessionEntry[],
		);
		const skillName = firstUserText
			? extractSkillName(firstUserText)
			: undefined;
		if (!firstUserText || !skillName) {
			return;
		}

		if (
			!shouldNameAfterTurn({
				hasSessionName: Boolean(pi.getSessionName()),
				skillName,
				turnIndex: event.turnIndex,
			})
		) {
			return;
		}

		pi.setSessionName(
			makeSessionTitle(skillName, extractUserRequest(firstUserText)),
		);
	});

	pi.on("session_start", (_event, ctx) => {
		maybeNameSkillSession(pi, ctx.sessionManager.getBranch() as SessionEntry[]);
		scheduleHistoricalBackfill();
	});
}

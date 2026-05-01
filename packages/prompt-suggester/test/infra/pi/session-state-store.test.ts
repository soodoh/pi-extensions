import { access, mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { INITIAL_RUNTIME_STATE } from "../../../src/domain/state";
import { SessionStateStore } from "../../../src/infra/pi/session-state-store";
import type { SessionReadableManager } from "../../../src/infra/pi/session-state-types";
import {
	createSessionStorageContext,
	stateFilePath,
} from "../../../src/infra/pi/session-storage-context";

function createInMemorySessionManager(): SessionReadableManager {
	return {
		getBranch() {
			return [];
		},
		getEntries() {
			return [];
		},
		getSessionFile() {
			return undefined;
		},
		getSessionId() {
			return "test/session";
		},
		getLeafId() {
			return "leaf-1";
		},
		getCwd() {
			return process.cwd();
		},
	};
}

function createPersistentSessionManager(cwd: string): SessionReadableManager {
	return {
		getBranch() {
			return [{ id: "root-entry" }, { id: "leaf-1" }];
		},
		getEntries() {
			return [];
		},
		getSessionFile() {
			return path.join(cwd, ".pi", "session.json");
		},
		getSessionId() {
			return "test/session";
		},
		getLeafId() {
			return "leaf-1";
		},
		getCwd() {
			return cwd;
		},
	};
}

test("SessionStateStore persists save/usage state for in-memory sessions", async () => {
	const store = new SessionStateStore("/unused/state-dir", () =>
		createInMemorySessionManager(),
	);
	await store.save({
		...INITIAL_RUNTIME_STATE,
		lastSuggestion: {
			text: "Go ahead.",
			shownAt: "2026-03-13T12:00:00.000Z",
			turnId: "turn-1",
			sourceLeafId: "leaf-1",
		},
	});
	await store.recordUsage("suggester", {
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 1,
		cacheWriteTokens: 0,
		totalTokens: 16,
		costTotal: 0.02,
	});

	const state = await store.load();
	expect(state.lastSuggestion?.text).toBe("Go ahead.");
	expect(state.suggestionUsage.calls).toBe(1);
	expect(state.suggestionUsage.inputTokens).toBe(10);
	expect(state.seederUsage.calls).toBe(0);
});

test("SessionStateStore writes persistent files under the provided project state directory", async () => {
	const cwd = await mkdtemp(
		path.join(os.tmpdir(), "pi-suggester-session-cwd-"),
	);
	const projectStateDir = await mkdtemp(
		path.join(os.tmpdir(), "pi-suggester-session-state-"),
	);
	const sessionManager = createPersistentSessionManager(cwd);
	const store = new SessionStateStore(projectStateDir, () => sessionManager);

	await store.save({
		...INITIAL_RUNTIME_STATE,
		lastSuggestion: {
			text: "Persist me",
			shownAt: "2026-03-13T12:00:00.000Z",
			turnId: "turn-1",
			sourceLeafId: "leaf-1",
		},
	});
	await store.recordUsage("suggester", {
		inputTokens: 3,
		outputTokens: 2,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 5,
		costTotal: 0.01,
	});

	const storageContext = createSessionStorageContext(
		projectStateDir,
		sessionManager,
	);
	if (!storageContext.persistent) {
		throw new Error("expected persistent storage context");
	}
	const interactionPath = stateFilePath(
		storageContext.interactionDir,
		"leaf-1",
	);
	const usagePath = storageContext.usageFile;
	const metaPath = storageContext.metaFile;

	await access(interactionPath);
	await access(usagePath);
	await access(metaPath);
	await expect(stat(storageContext.storageDir)).resolves.toMatchObject({
		mode: expect.any(Number),
	});
	expect((await stat(storageContext.storageDir)).mode & 0o777).toBe(0o700);
	expect((await stat(storageContext.interactionDir)).mode & 0o777).toBe(0o700);
	expect((await stat(interactionPath)).mode & 0o777).toBe(0o600);
	expect((await stat(usagePath)).mode & 0o777).toBe(0o600);
	expect((await stat(metaPath)).mode & 0o777).toBe(0o600);

	const state = await store.load();
	expect(state.lastSuggestion?.text).toBe("Persist me");
	expect(state.suggestionUsage.calls).toBe(1);
});

test("session state normalization rejects non-finite and negative persisted numbers", async () => {
	const data = await import("../../../src/infra/pi/session-state-data");

	expect(
		data.normalizeInteractionState({
			turnsSinceLastStalenessCheck: Number.POSITIVE_INFINITY,
		}),
	).toMatchObject({ turnsSinceLastStalenessCheck: 0 });
	expect(
		data.normalizeInteractionState({ turnsSinceLastStalenessCheck: -3 }),
	).toMatchObject({ turnsSinceLastStalenessCheck: 0 });

	expect(
		data.normalizePersistedUsagePair({
			suggestionUsage: { calls: -1, inputTokens: Number.NaN },
			seederUsage: { calls: 2, costTotal: Number.NEGATIVE_INFINITY },
		}),
	).toMatchObject({
		suggester: { calls: 0, inputTokens: 0 },
		seeder: { calls: 2, costTotal: 0 },
	});
});

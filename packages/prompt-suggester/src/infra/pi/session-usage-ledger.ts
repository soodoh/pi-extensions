import { promises as fs } from "node:fs";
import path from "node:path";
import type { SuggestionUsage } from "../../domain/suggestion";
import { addUsageStats } from "../../domain/usage";
import { atomicWriteJson } from "../storage/atomic-write";
import { readJsonIfExists } from "../storage/json-file";
import {
	emptyUsagePair,
	normalizePersistedUsagePair,
} from "./session-state-data";
import {
	type PersistedUsageState,
	type SessionStorageContext,
	STORE_SCHEMA_VERSION,
	type SuggestionUsageStatsPair,
} from "./session-state-types";

export class SessionUsageLedger {
	private readonly usageTasks = new Map<string, Promise<void>>();

	public async load(
		context: Extract<SessionStorageContext, { persistent: true }>,
	): Promise<SuggestionUsageStatsPair> {
		const persisted = await readJsonIfExists<PersistedUsageState>(
			context.usageFile,
		);
		if (!persisted) return emptyUsagePair();
		return normalizePersistedUsagePair(persisted);
	}

	public async record(
		context: Extract<SessionStorageContext, { persistent: true }>,
		kind: "suggester" | "seeder",
		usage: SuggestionUsage,
	): Promise<void> {
		const usageKey = context.usageFile;
		const existingTask = this.usageTasks.get(usageKey) ?? Promise.resolve();
		const task = existingTask.then(async () => {
			const current = await this.load(context);
			const next = {
				suggester:
					kind === "suggester"
						? addUsageStats(current.suggester, usage)
						: current.suggester,
				seeder:
					kind === "seeder"
						? addUsageStats(current.seeder, usage)
						: current.seeder,
			};
			await fs.mkdir(path.dirname(usageKey), { recursive: true });
			await atomicWriteJson(usageKey, {
				schemaVersion: STORE_SCHEMA_VERSION,
				suggestionUsage: next.suggester,
				seederUsage: next.seeder,
				updatedAt: new Date().toISOString(),
			} satisfies PersistedUsageState);
		});
		const trackedTask = task.finally(() => {
			if (this.usageTasks.get(usageKey) === trackedTask)
				this.usageTasks.delete(usageKey);
		});
		this.usageTasks.set(usageKey, trackedTask);
		await trackedTask;
	}
}

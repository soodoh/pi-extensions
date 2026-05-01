import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import {
	CURRENT_RUNTIME_STATE_VERSION,
	INITIAL_RUNTIME_STATE,
	type RuntimeState,
	type SuggestionUsageStats,
} from "../../domain/state";
import type { SuggestionUsage } from "../../domain/suggestion";
import {
	addUsageStats,
	cloneUsageStats,
	emptyUsageStats,
	normalizeFiniteNonNegativeNumber,
	normalizeUsageStats,
} from "../../domain/usage";
import {
	LEGACY_STATE_CUSTOM_TYPE,
	LEGACY_USAGE_CUSTOM_TYPE,
	type PersistedInteractionState,
	type SuggestionUsageStatsPair,
	type UsageLedgerEntry,
} from "./session-state-types";

export function emptyUsagePair(): SuggestionUsageStatsPair {
	return {
		suggester: emptyUsageStats(),
		seeder: emptyUsageStats(),
	};
}

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

function parseUsage(raw: unknown): SuggestionUsage | undefined {
	if (!isObjectRecord(raw)) return undefined;
	return {
		inputTokens: normalizeFiniteNonNegativeNumber(raw.inputTokens),
		outputTokens: normalizeFiniteNonNegativeNumber(raw.outputTokens),
		cacheReadTokens: normalizeFiniteNonNegativeNumber(raw.cacheReadTokens),
		cacheWriteTokens: normalizeFiniteNonNegativeNumber(raw.cacheWriteTokens),
		totalTokens: normalizeFiniteNonNegativeNumber(raw.totalTokens),
		costTotal: normalizeFiniteNonNegativeNumber(raw.costTotal),
	};
}

export function normalizeInteractionState(
	raw: unknown,
): PersistedInteractionState {
	const latest = (raw ?? INITIAL_RUNTIME_STATE) as Partial<RuntimeState> & {
		steeringHistory?: unknown;
	};
	return {
		stateVersion: CURRENT_RUNTIME_STATE_VERSION,
		lastSuggestion: latest.lastSuggestion,
		pendingNextTurnObservation: latest.pendingNextTurnObservation,
		steeringHistory: Array.isArray(latest.steeringHistory)
			? latest.steeringHistory
			: [],
		turnsSinceLastStalenessCheck: normalizeFiniteNonNegativeNumber(
			latest.turnsSinceLastStalenessCheck,
		),
	};
}

export function toRuntimeState(
	interaction: PersistedInteractionState,
	usage: SuggestionUsageStatsPair,
): RuntimeState {
	return {
		stateVersion: CURRENT_RUNTIME_STATE_VERSION,
		lastSuggestion: interaction.lastSuggestion,
		pendingNextTurnObservation: interaction.pendingNextTurnObservation,
		steeringHistory: interaction.steeringHistory,
		suggestionUsage: cloneUsageStats(usage.suggester),
		seederUsage: cloneUsageStats(usage.seeder),
		turnsSinceLastStalenessCheck: interaction.turnsSinceLastStalenessCheck,
	};
}

export function toPersistedInteractionState(
	state: RuntimeState,
): PersistedInteractionState {
	return normalizeInteractionState({
		stateVersion: CURRENT_RUNTIME_STATE_VERSION,
		lastSuggestion: state.lastSuggestion,
		pendingNextTurnObservation: state.pendingNextTurnObservation,
		steeringHistory: state.steeringHistory,
		turnsSinceLastStalenessCheck: state.turnsSinceLastStalenessCheck,
	});
}

export function extractUsageTotals(entries: SessionEntry[]): {
	hasLedger: boolean;
	suggester: SuggestionUsageStats;
	seeder: SuggestionUsageStats;
	legacyUsageEntryCount: number;
} {
	let hasLedger = false;
	let legacyUsageEntryCount = 0;
	let suggester = emptyUsageStats();
	let seeder = emptyUsageStats();

	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== LEGACY_USAGE_CUSTOM_TYPE
		)
			continue;
		legacyUsageEntryCount += 1;
		const data = entry.data as UsageLedgerEntry;
		const usage = parseUsage(data?.usage);
		if (!usage) continue;
		hasLedger = true;
		if (data.kind === "seeder") seeder = addUsageStats(seeder, usage);
		else suggester = addUsageStats(suggester, usage);
	}

	return { hasLedger, suggester, seeder, legacyUsageEntryCount };
}

export function extractLegacyInteractionSnapshots(
	entries: SessionEntry[],
): Map<string, PersistedInteractionState> {
	const snapshots = new Map<string, PersistedInteractionState>();
	for (const entry of entries) {
		if (
			entry.type !== "custom" ||
			entry.customType !== LEGACY_STATE_CUSTOM_TYPE
		)
			continue;
		snapshots.set(entry.id, normalizeInteractionState(entry.data));
	}
	return snapshots;
}

export function normalizePersistedUsagePair(
	raw:
		| {
				suggestionUsage?: unknown;
				seederUsage?: unknown;
		  }
		| undefined,
): SuggestionUsageStatsPair {
	return {
		suggester: normalizeUsageStats(raw?.suggestionUsage, emptyUsageStats()),
		seeder: normalizeUsageStats(raw?.seederUsage, emptyUsageStats()),
	};
}

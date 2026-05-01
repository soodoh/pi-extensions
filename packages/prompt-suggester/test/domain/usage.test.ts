import { expect, test } from "vitest";
import {
	accumulateUsage,
	addUsageStats,
	createEmptyUsage,
	emptyUsageStats,
	normalizeUsageStats,
} from "../../src/domain/usage";

test("addUsageStats increments counters and keeps last usage", () => {
	const current = emptyUsageStats();
	const usage = {
		inputTokens: 11,
		outputTokens: 7,
		cacheReadTokens: 3,
		cacheWriteTokens: 2,
		totalTokens: 23,
		costTotal: 0.12,
	};

	expect(addUsageStats(current, usage)).toEqual({
		calls: 1,
		inputTokens: 11,
		outputTokens: 7,
		cacheReadTokens: 3,
		cacheWriteTokens: 2,
		totalTokens: 23,
		costTotal: 0.12,
		last: usage,
	});
});

test("accumulateUsage combines multiple usage objects", () => {
	const first = {
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 0,
		cacheWriteTokens: 1,
		totalTokens: 16,
		costTotal: 0.01,
	};
	const second = {
		inputTokens: 4,
		outputTokens: 9,
		cacheReadTokens: 2,
		cacheWriteTokens: 0,
		totalTokens: 15,
		costTotal: 0.02,
	};

	expect(accumulateUsage(first, second)).toEqual({
		inputTokens: 14,
		outputTokens: 14,
		cacheReadTokens: 2,
		cacheWriteTokens: 1,
		totalTokens: 31,
		costTotal: 0.03,
	});
	expect(accumulateUsage(createEmptyUsage(), undefined)).toEqual(
		createEmptyUsage(),
	);
});

test("normalizeUsageStats falls back to zeros for missing data", () => {
	expect(normalizeUsageStats(undefined)).toEqual({
		...emptyUsageStats(),
		last: undefined,
	});
	expect(normalizeUsageStats({ inputTokens: 3, calls: 2 })).toEqual({
		calls: 2,
		inputTokens: 3,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 0,
		costTotal: 0,
		last: undefined,
	});
});

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { validateConfig } from "../../src/config/schema";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const defaultConfig = JSON.parse(
	await readFile(path.join(repoRoot, "prompt-suggester.config.json"), "utf8"),
);

test("validateConfig accepts shipped defaults", () => {
	expect(validateConfig(defaultConfig)).toBe(true);
});

test("validateConfig rejects unknown keys and invalid values", () => {
	expect(validateConfig({ ...defaultConfig, extra: true })).toBe(false);
	expect(
		validateConfig({
			...defaultConfig,
			suggestion: { ...defaultConfig.suggestion, maxSuggestionChars: 0 },
		}),
	).toBe(false);
	expect(
		validateConfig({
			...defaultConfig,
			suggestion: { ...defaultConfig.suggestion, ghostAcceptKeys: [] },
		}),
	).toBe(false);
	expect(
		validateConfig({
			...defaultConfig,
			suggestion: {
				...defaultConfig.suggestion,
				ghostAcceptKeys: ["space", "tab"],
			},
		}),
	).toBe(false);
});

test("validateConfig accepts supported ghost accept key combinations", () => {
	expect(defaultConfig.suggestion.ghostAcceptKeys).toEqual(["right"]);
	expect(defaultConfig.suggestion.ghostAcceptAndSendKeys).toEqual(["enter"]);
	expect(
		validateConfig({
			...defaultConfig,
			suggestion: { ...defaultConfig.suggestion, ghostAcceptKeys: ["space"] },
		}),
	).toBe(true);
	expect(
		validateConfig({
			...defaultConfig,
			suggestion: { ...defaultConfig.suggestion, ghostAcceptKeys: ["right"] },
		}),
	).toBe(true);
	expect(
		validateConfig({
			...defaultConfig,
			suggestion: {
				...defaultConfig.suggestion,
				ghostAcceptKeys: ["space", "right"],
			},
		}),
	).toBe(true);
	expect(
		validateConfig({
			...defaultConfig,
			suggestion: { ...defaultConfig.suggestion, ghostAcceptKeys: ["enter"] },
		}),
	).toBe(true);
	expect(
		validateConfig({
			...defaultConfig,
			suggestion: {
				...defaultConfig.suggestion,
				ghostAcceptKeys: ["space", "right", "enter"],
			},
		}),
	).toBe(true);
	expect(
		validateConfig({
			...defaultConfig,
			suggestion: {
				...defaultConfig.suggestion,
				ghostAcceptAndSendKeys: ["enter"],
			},
		}),
	).toBe(true);
});

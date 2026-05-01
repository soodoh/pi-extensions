import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Model, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { expect, test } from "vitest";
import type { Logger } from "../../../src/app/ports/logger";
import type { SuggestionPromptContext } from "../../../src/app/services/prompt-context-builder";
import {
	globToRegExp,
	PiModelClient,
	type RuntimeContextProvider,
} from "../../../src/infra/model/pi-model-client";

const { registerApiProvider, unregisterApiProviders } = await import(
	pathToFileURL(
		join(
			process.cwd(),
			"node_modules/@mariozechner/pi-ai/dist/api-registry.js",
		),
	).href
);

const CLAUDE_BRIDGE_STREAM_SIMPLE_KEY = Symbol.for(
	"claude-bridge:activeStreamSimple",
);

type TestModel = Model<string>;
type AuthResult =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string };
type CompletionResponse = {
	content: Array<{ type: "text"; text: string }>;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { total: number };
	};
};

type RuntimeOverrides = {
	hasUI?: boolean;
	notify?: (message: string, level?: string) => void;
	getApiKeyAndHeaders?: (model: TestModel) => Promise<AuthResult>;
};

function createRuntimeWithModel(
	model: TestModel,
	overrides: RuntimeOverrides = {},
): RuntimeContextProvider {
	const notify = overrides.notify ?? (() => undefined);
	return {
		getContext() {
			return {
				model,
				modelRegistry: {
					getAll() {
						return [model];
					},
					async getApiKeyAndHeaders(requestedModel: TestModel) {
						expect(requestedModel).toBe(model);
						return overrides.getApiKeyAndHeaders
							? await overrides.getApiKeyAndHeaders(requestedModel)
							: { ok: true };
					},
				},
				hasUI: overrides.hasUI ?? false,
				ui: { notify },
			};
		},
	};
}

function createSuggestionContext(): SuggestionPromptContext {
	return {
		latestAssistantTurn: "I can do that.",
		turnStatus: "success",
		intentSeed: null,
		recentUserPrompts: ["Fix the tests"],
		toolSignals: [],
		touchedFiles: [],
		unresolvedQuestions: [],
		recentChanged: [],
		customInstruction: "",
		noSuggestionToken: "[no suggestion]",
		maxSuggestionChars: 200,
	};
}

function createModel(api: string, provider = "test"): TestModel {
	return {
		api,
		provider,
		id: "model-1",
		name: "model-1",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	};
}

function successResponse(text: string): CompletionResponse {
	return {
		content: [{ type: "text", text }],
		usage: {
			input: 1,
			output: text.trim() ? 1 : 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { total: 0 },
		},
	};
}

function registerTestProvider(
	response: CompletionResponse,
	onOptions?: (options: SimpleStreamOptions | undefined) => void,
) {
	const api = `test-api-${Math.random().toString(36).slice(2)}`;
	const sourceId = `test-provider-${Math.random().toString(36).slice(2)}`;
	registerApiProvider(
		{
			api,
			stream() {
				throw new Error("stream should not be used in these tests");
			},
			streamSimple(
				_model: TestModel,
				_context: unknown,
				options?: SimpleStreamOptions,
			) {
				onOptions?.(options);
				return {
					async result() {
						return response;
					},
				};
			},
		},
		sourceId,
	);
	return {
		sourceId,
		model: createModel(api),
		unregister() {
			unregisterApiProviders(sourceId);
		},
	};
}

test("globToRegExp supports single-character ? wildcards", () => {
	const matcher = globToRegExp("src/file?.ts");
	expect(matcher.test("src/file1.ts")).toBe(true);
	expect(matcher.test("src/fileA.ts")).toBe(true);
	expect(matcher.test("src/file10.ts")).toBe(false);
	expect(matcher.test("src/file/.ts")).toBe(false);
});

test("globToRegExp treats **/ as matching root-level files", () => {
	const matcher = globToRegExp("**/*.ts");
	expect(matcher.test("index.ts")).toBe(true);
	expect(matcher.test("src/index.ts")).toBe(true);
	expect(matcher.test("src/nested/index.ts")).toBe(true);
});

test("PiModelClient find tool matches root files for plain patterns", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-suggester-find-"));
	await writeFile(join(cwd, "package.json"), "{}\n", "utf8");
	let callCount = 0;
	const api = `test-api-${Math.random().toString(36).slice(2)}`;
	const sourceId = `test-provider-${Math.random().toString(36).slice(2)}`;
	registerApiProvider(
		{
			api,
			stream() {
				throw new Error("stream should not be used in these tests");
			},
			streamSimple() {
				callCount += 1;
				return {
					async result() {
						return successResponse(
							callCount === 1
								? JSON.stringify({
										type: "tool",
										tool: "find",
										arguments: { pattern: "package.json" },
									})
								: JSON.stringify({
										type: "final",
										seed: {
											projectIntentSummary: "Test project",
											objectivesSummary: "Exercise find tool",
											constraintsSummary: "Keep tests small",
											principlesGuidelinesSummary: "Use fixtures",
											implementationStatusSummary: "Ready",
											topObjectives: ["Exercise find tool"],
											constraints: ["Keep tests small"],
											keyFiles: [
												{
													path: "package.json",
													category: "vision",
													whyImportant: "Root package metadata",
												},
											],
											categoryFindings: {
												vision: {
													found: true,
													rationale: "Root metadata found",
												},
												architecture: {
													found: false,
													rationale: "Not needed for this fixture",
												},
												principles_guidelines: {
													found: false,
													rationale: "Not needed for this fixture",
												},
											},
										},
									}),
						);
					},
				};
			},
		},
		sourceId,
	);
	t.onTestFinished(() => unregisterApiProviders(sourceId));
	const toolResults: string[] = [];
	const logger: Logger = {
		debug() {},
		info(_message, meta) {
			if (typeof meta?.toolResultPreview === "string") {
				toolResults.push(meta.toolResultPreview);
			}
		},
		warn() {},
		error() {},
	};
	const model = createModel(api);
	const client = new PiModelClient(createRuntimeWithModel(model), logger, cwd);

	await client.generateSeed({
		reseedTrigger: { reason: "manual", changedFiles: [] },
		previousSeed: null,
	});

	expect(toolResults).toContain("package.json");
});

test("PiModelClient resolves auth via getApiKeyAndHeaders when available", async (t) => {
	let observedOptions: SimpleStreamOptions | undefined;
	const provider = registerTestProvider(successResponse("ok"), (options) => {
		observedOptions = options;
	});
	t.onTestFinished(() => provider.unregister());
	const client = new PiModelClient(
		createRuntimeWithModel(provider.model, {
			async getApiKeyAndHeaders() {
				return {
					ok: true,
					apiKey: "token-123",
					headers: { "x-test": "1" },
				};
			},
		}),
	);

	await client.generateSuggestion(createSuggestionContext());

	expect(observedOptions?.apiKey).toBe("token-123");
	expect(observedOptions?.headers).toEqual({ "x-test": "1" });
});

test("PiModelClient accepts header-only auth results from getApiKeyAndHeaders", async (t) => {
	let observedOptions: SimpleStreamOptions | undefined;
	const provider = registerTestProvider(successResponse("ok"), (options) => {
		observedOptions = options;
	});
	t.onTestFinished(() => provider.unregister());
	const client = new PiModelClient(
		createRuntimeWithModel(provider.model, {
			async getApiKeyAndHeaders() {
				return {
					ok: true,
					headers: { Authorization: "Bearer delegated" },
				};
			},
		}),
	);

	await client.generateSuggestion(createSuggestionContext());

	expect(observedOptions?.apiKey).toBeUndefined();
	expect(observedOptions?.headers).toEqual({
		Authorization: "Bearer delegated",
	});
});

test("PiModelClient falls back to getApiKey for older ModelRegistry versions", async (t) => {
	let observedOptions: SimpleStreamOptions | undefined;
	const provider = registerTestProvider(successResponse("ok"), (options) => {
		observedOptions = options;
	});
	t.onTestFinished(() => provider.unregister());
	const model = provider.model;
	const client = new PiModelClient({
		getContext() {
			return {
				model,
				modelRegistry: {
					getAll() {
						return [model];
					},
					async getApiKey(requestedModel: TestModel) {
						expect(requestedModel).toBe(model);
						return "legacy-token";
					},
				},
				hasUI: false,
				ui: { notify() {} },
			};
		},
	});

	await client.generateSuggestion(createSuggestionContext());

	expect(observedOptions?.apiKey).toBe("legacy-token");
});

test("PiModelClient surfaces ModelRegistry auth errors", async (t) => {
	const provider = registerTestProvider(successResponse("ok"));
	t.onTestFinished(() => provider.unregister());
	const client = new PiModelClient(
		createRuntimeWithModel(provider.model, {
			async getApiKeyAndHeaders() {
				return { ok: false, error: "missing auth" };
			},
		}),
	);

	await expect(
		client.generateSuggestion(createSuggestionContext()),
	).rejects.toThrow(/missing auth/);
});

test("PiModelClient allows empty text for suggestions", async (t) => {
	const provider = registerTestProvider(successResponse("   "));
	t.onTestFinished(() => provider.unregister());
	const client = new PiModelClient(createRuntimeWithModel(provider.model));

	const result = await client.generateSuggestion(createSuggestionContext());

	expect(result.text).toBe("");
	expect(typeof result.usage?.totalTokens).toBe("number");
});

test("PiModelClient uses claude-bridge global shim when local provider registry cannot resolve it", async (t) => {
	const bridgeModel = createModel("claude-bridge", "claude-bridge");
	Reflect.set(globalThis, CLAUDE_BRIDGE_STREAM_SIMPLE_KEY, () => ({
		async result() {
			return successResponse("Use the test shim.");
		},
	}));
	t.onTestFinished(() => {
		Reflect.deleteProperty(globalThis, CLAUDE_BRIDGE_STREAM_SIMPLE_KEY);
	});
	const client = new PiModelClient(createRuntimeWithModel(bridgeModel));

	const result = await client.generateSuggestion(createSuggestionContext());

	expect(result.text).toBe("Use the test shim.");
	expect(result.usage?.totalTokens).toBe(1);
});

test("PiModelClient degrades unsupported providers to empty suggestions and warns once", async () => {
	const unsupportedModel = createModel("custom-bridge", "custom");
	const warnings: Array<{ message: string; meta?: Record<string, unknown> }> =
		[];
	const notifications: Array<{ message: string; level?: string }> = [];
	const logger: Logger = {
		debug() {},
		info() {},
		warn(message, meta) {
			warnings.push({ message, meta });
		},
		error() {},
	};
	const client = new PiModelClient(
		createRuntimeWithModel(unsupportedModel, {
			hasUI: true,
			notify(message, level) {
				notifications.push({ message, level });
			},
		}),
		logger,
	);

	const first = await client.generateSuggestion(createSuggestionContext());
	const second = await client.generateSuggestion(createSuggestionContext());

	expect(first.text).toBe("");
	expect(second.text).toBe("");
	expect(warnings.length).toBe(1);
	expect(warnings[0].message).toBe("suggestion.provider.incompatible");
	expect(notifications.length).toBe(1);
	expect(notifications[0].message).toMatch(/isn't directly compatible/);
});

test("PiModelClient fails clearly for unsupported seeder providers", async () => {
	const unsupportedModel = createModel("custom-bridge", "custom");
	const client = new PiModelClient(createRuntimeWithModel(unsupportedModel));

	await expect(
		client.generateSeed({
			reseedTrigger: { reason: "manual", changedFiles: [] },
			previousSeed: null,
		}),
	).rejects.toThrow(/not generate a seed with provider 'custom-bridge'/);
});

test("PiModelClient still rejects empty text for seeder", async (t) => {
	const provider = registerTestProvider(successResponse("   "));
	t.onTestFinished(() => provider.unregister());
	const client = new PiModelClient(createRuntimeWithModel(provider.model));

	await expect(
		client.generateSeed({
			reseedTrigger: { reason: "manual", changedFiles: [] },
			previousSeed: null,
		}),
	).rejects.toThrow(/Model returned empty text/);
});

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { PiModelClient } from "../../../src/infra/model/pi-model-client";

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

function createClient() {
	return new PiModelClient({
		getContext() {
			return undefined;
		},
	});
}

function createRuntimeWithModel(model, overrides = {}) {
	const notify = overrides.notify ?? (() => {});
	return {
		getContext() {
			return {
				model,
				modelRegistry: {
					getAll() {
						return [model];
					},
					async getApiKeyAndHeaders(requestedModel) {
						expect(requestedModel).toBe(model);
						return { ok: true };
					},
				},
				hasUI: overrides.hasUI ?? false,
				ui: { notify },
			};
		},
	};
}

function createSuggestionContext() {
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

function registerTestProvider(response) {
	const api = `test-api-${Math.random().toString(36).slice(2)}`;
	const sourceId = `test-provider-${Math.random().toString(36).slice(2)}`;
	registerApiProvider(
		{
			api,
			stream() {
				throw new Error("stream should not be used in these tests");
			},
			streamSimple() {
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
		model: {
			api,
			provider: "test",
			id: "model-1",
			name: "model-1",
			baseUrl: "http://localhost",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 1000,
		},
		unregister() {
			unregisterApiProviders(sourceId);
		},
	};
}

const model = { provider: "openai", id: "gpt-5" };

test("PiModelClient resolves auth via getApiKeyAndHeaders when available", async () => {
	const client = createClient();
	const auth = await client.resolveRequestAuth(model, {
		async getApiKeyAndHeaders(requestedModel) {
			expect(requestedModel).toBe(model);
			return {
				ok: true,
				apiKey: "token-123",
				headers: { "x-test": "1" },
			};
		},
		async getApiKey() {
			throw new Error("fallback should not be used");
		},
	});

	expect(auth).toEqual({
		apiKey: "token-123",
		headers: { "x-test": "1" },
	});
});

test("PiModelClient accepts header-only auth results from getApiKeyAndHeaders", async () => {
	const client = createClient();
	const auth = await client.resolveRequestAuth(model, {
		async getApiKeyAndHeaders() {
			return {
				ok: true,
				headers: { Authorization: "Bearer delegated" },
			};
		},
	});

	expect(auth).toEqual({
		apiKey: undefined,
		headers: { Authorization: "Bearer delegated" },
	});
});

test("PiModelClient falls back to getApiKey for older ModelRegistry versions", async () => {
	const client = createClient();
	const auth = await client.resolveRequestAuth(model, {
		async getApiKey(requestedModel) {
			expect(requestedModel).toBe(model);
			return "legacy-token";
		},
	});

	expect(auth).toEqual({
		apiKey: "legacy-token",
	});
});

test("PiModelClient surfaces ModelRegistry auth errors", async () => {
	const client = createClient();
	await expect(
		client.resolveRequestAuth(model, {
			async getApiKeyAndHeaders() {
				return { ok: false, error: "missing auth" };
			},
		}),
	).rejects.toThrow(/missing auth/);
});

test("PiModelClient allows empty text for suggestions", async (t) => {
	const provider = registerTestProvider({
		content: [{ type: "text", text: "   " }],
		usage: {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { total: 0 },
		},
	});
	t.onTestFinished(() => provider.unregister());
	const client = new PiModelClient(createRuntimeWithModel(provider.model));

	const result = await client.generateSuggestion(createSuggestionContext());

	expect(result.text).toBe("");
	expect(typeof result.usage?.totalTokens).toBe("number");
});

test("PiModelClient uses claude-bridge global shim when local provider registry cannot resolve it", async (t) => {
	const bridgeModel = {
		api: "claude-bridge",
		provider: "claude-bridge",
		id: "opus",
		name: "opus",
		baseUrl: "claude-bridge",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	};
	globalThis[CLAUDE_BRIDGE_STREAM_SIMPLE_KEY] = () => ({
		async result() {
			return {
				content: [{ type: "text", text: "Use the test shim." }],
				usage: {
					input: 2,
					output: 3,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { total: 0 },
				},
			};
		},
	});
	t.onTestFinished(() => {
		globalThis[CLAUDE_BRIDGE_STREAM_SIMPLE_KEY] = undefined;
	});
	const client = new PiModelClient(createRuntimeWithModel(bridgeModel));

	const result = await client.generateSuggestion(createSuggestionContext());

	expect(result.text).toBe("Use the test shim.");
	expect(result.usage?.totalTokens).toBe(5);
});

test("PiModelClient degrades unsupported providers to empty suggestions and warns once", async () => {
	const unsupportedModel = {
		api: "custom-bridge",
		provider: "custom",
		id: "model-1",
		name: "model-1",
		baseUrl: "custom-bridge",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	};
	const warnings = [];
	const notifications = [];
	const client = new PiModelClient(
		createRuntimeWithModel(unsupportedModel, {
			hasUI: true,
			notify(message, level) {
				notifications.push({ message, level });
			},
		}),
		{
			debug() {},
			info() {},
			warn(message, meta) {
				warnings.push({ message, meta });
			},
			error() {},
		},
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
	const unsupportedModel = {
		api: "custom-bridge",
		provider: "custom",
		id: "model-1",
		name: "model-1",
		baseUrl: "custom-bridge",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	};
	const client = new PiModelClient(createRuntimeWithModel(unsupportedModel));

	await expect(
		client.generateSeed({
			reseedTrigger: { reason: "manual", changedFiles: [] },
			previousSeed: null,
		}),
	).rejects.toThrow(/not generate a seed with provider 'custom-bridge'/);
});

test("PiModelClient still rejects empty text for seeder", async (t) => {
	const provider = registerTestProvider({
		content: [{ type: "text", text: "   " }],
		usage: {
			input: 1,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { total: 0 },
		},
	});
	t.onTestFinished(() => provider.unregister());
	const client = new PiModelClient(createRuntimeWithModel(provider.model));

	await expect(
		client.generateSeed({
			reseedTrigger: { reason: "manual", changedFiles: [] },
			previousSeed: null,
		}),
	).rejects.toThrow(/Model returned empty text/);
});

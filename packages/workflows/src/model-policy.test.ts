import { describe, expect, test, vi } from "vitest";
import {
	applyModelPolicy,
	type RegistryLike,
	selectModel,
} from "./model-policy";

const models = [
	{
		provider: "openai",
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		contextWindow: 128_000,
	},
	{
		provider: "anthropic",
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		contextWindow: 200_000,
	},
	{
		provider: "openai",
		id: "codex-pro",
		name: "Codex Pro",
		contextWindow: 200_000,
	},
];

function registry(): RegistryLike {
	return {
		getAvailable() {
			return models;
		},
		find(provider, id) {
			return models.find(
				(model) => model.provider === provider && model.id === id,
			);
		},
		hasConfiguredAuth(model) {
			return model.id !== "gpt-5-mini";
		},
	};
}

describe("model policy", () => {
	test("selectModel inherits when policy disables model selection", async () => {
		const selection = await selectModel(
			{ model: "inherit", thinking: "high" },
			registry(),
			"worker",
		);

		expect(selection.model).toBeUndefined();
		expect(selection.thinking).toBe("high");
		expect(selection.reason).toContain("inherited current model");
	});

	test("selectModel auto-selects an authenticated stage-appropriate candidate", async () => {
		const selection = await selectModel(
			{ model: "auto", thinking: "medium" },
			registry(),
			"worker",
			"complex",
		);

		expect(selection.modelKey).toBe("anthropic/claude-sonnet-4");
		expect(selection.thinking).toBe("medium");
		expect(selection.reason).toContain("auto stage scoring");
	});

	test("selectModel uses first configured authenticated candidate without auto scoring", async () => {
		const selection = await selectModel(
			{
				models: ["openai/gpt-5-mini", "anthropic/claude-sonnet-4"],
				autoSelectModel: false,
				thinking: "low",
			},
			registry(),
			"reviewer",
		);

		expect(selection.modelKey).toBe("anthropic/claude-sonnet-4");
		expect(selection.reason).toContain("first available candidate");
	});

	test("applyModelPolicy applies selected model and explicit thinking", async () => {
		const setModel = vi.fn();
		const setThinkingLevel = vi.fn();

		const selection = await applyModelPolicy(
			{ setModel, setThinkingLevel },
			{ modelRegistry: registry() },
			{ models: ["anthropic/claude-sonnet-4"], thinking: "high" },
			"planning",
		);

		expect(selection.modelKey).toBe("anthropic/claude-sonnet-4");
		expect(setModel).toHaveBeenCalledWith(models[1]);
		expect(setThinkingLevel).toHaveBeenCalledWith("high");
	});
});

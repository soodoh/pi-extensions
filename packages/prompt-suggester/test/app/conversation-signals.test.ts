import { describe, expect, test } from "vitest";
import { buildTurnContext } from "../../src/app/services/conversation-signals";

describe("conversation signal extraction", () => {
	test("malformed assistant tool call arguments do not throw", () => {
		const messages = JSON.parse(`[
			{
				"role": "user",
				"content": "Inspect the project",
				"timestamp": 1
			},
			{
				"role": "assistant",
				"content": [
					{ "type": "toolCall", "name": "read", "arguments": "not an object" },
					{ "type": "toolCall", "name": "edit", "arguments": null },
					{ "type": "toolCall", "name": "glob" },
					{ "type": "toolCall", "name": "bash", "arguments": { "command": "bun test" } },
					{ "type": "text", "text": "Done" }
				],
				"timestamp": 2
			}
		]`);

		const context = buildTurnContext({
			turnId: "turn-1",
			sourceLeafId: "leaf-1",
			messagesFromPrompt: messages,
			branchMessages: messages,
			occurredAt: "2026-05-01T00:00:00.000Z",
		});

		expect(context?.toolSignals).toEqual([
			"read",
			"edit",
			"glob",
			"bash(bun test)",
		]);
		expect(context?.touchedFiles).toEqual([]);
	});
});

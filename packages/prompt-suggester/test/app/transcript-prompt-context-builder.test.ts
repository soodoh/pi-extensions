import { expect, test } from "vitest";
import { TranscriptPromptContextBuilder } from "../../src/app/services/transcript-prompt-context-builder";

const baseConfig = {
	schemaVersion: 7,
	seed: { maxDiffChars: 3000 },
	reseed: {
		enabled: true,
		checkOnSessionStart: true,
		checkAfterEveryTurn: true,
		turnCheckInterval: 10,
	},
	suggestion: {
		noSuggestionToken: "[no suggestion]",
		customInstruction: "Prefer terse confirmations.",
		fastPathContinueOnError: true,
		maxAssistantTurnChars: 100000,
		maxRecentUserPrompts: 20,
		maxRecentUserPromptChars: 500,
		maxToolSignals: 8,
		maxToolSignalChars: 240,
		maxTouchedFiles: 8,
		maxUnresolvedQuestions: 6,
		maxAbortContextChars: 280,
		maxSuggestionChars: 200,
		prefillOnlyWhenEditorEmpty: true,
		strategy: "compact",
		transcriptMaxContextPercent: 70,
		transcriptMaxMessages: 120,
		transcriptMaxChars: 120000,
		transcriptRolloutPercent: 100,
	},
	steering: {
		historyWindow: 20,
		acceptedThreshold: 0.82,
		maxChangedExamples: 2,
	},
	logging: { level: "info" },
	inference: {
		seederModel: "session-default",
		suggesterModel: "session-default",
		seederThinking: "session-default",
		suggesterThinking: "session-default",
	},
};

test("TranscriptPromptContextBuilder preserves transcript metadata and slices changed examples", () => {
	const builder = new TranscriptPromptContextBuilder(baseConfig, {
		getActiveTranscript() {
			return {
				systemPrompt: "system prompt",
				sessionId: "session-123",
				contextUsagePercent: 42,
				messages: [
					{
						role: "user",
						timestamp: 1,
						content: [{ type: "text", text: "fix the tests" }],
					},
					{
						role: "assistant",
						api: "openai-responses",
						provider: "openai",
						model: "gpt-5",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						stopReason: "stop",
						timestamp: 2,
						content: [{ type: "text", text: "I can do that." }],
					},
				],
			};
		},
	});

	const context = builder.build(null, {
		recentChanged: [
			{
				suggestedPrompt: "Yes.",
				actualUserPrompt: "Write tests first.",
				classification: "changed_course",
				similarity: 0.2,
				timestamp: "2026-03-15T00:00:00.000Z",
				turnId: "1",
			},
			{
				suggestedPrompt: "Proceed.",
				actualUserPrompt: "Use pnpm.",
				classification: "changed_course",
				similarity: 0.1,
				timestamp: "2026-03-15T00:01:00.000Z",
				turnId: "2",
			},
			{
				suggestedPrompt: "Ship it.",
				actualUserPrompt: "No, add tests.",
				classification: "changed_course",
				similarity: 0.1,
				timestamp: "2026-03-15T00:02:00.000Z",
				turnId: "3",
			},
		],
	});

	expect(context.systemPrompt).toBe("system prompt");
	expect(context.sessionId).toBe("session-123");
	expect(context.contextUsagePercent).toBe(42);
	expect(context.transcriptMessageCount).toBe(2);
	expect(context.transcriptMessages[0].content[0].text).toBe("fix the tests");
	expect(context.transcriptCharCount > 0).toBe(true);
	expect(context.recentChanged.length).toBe(2);
	expect(context.customInstruction).toBe("Prefer terse confirmations.");
	expect(context.noSuggestionToken).toBe("[no suggestion]");
});

test("TranscriptPromptContextBuilder throws when transcript is unavailable", () => {
	const builder = new TranscriptPromptContextBuilder(baseConfig, {
		getActiveTranscript() {
			return undefined;
		},
	});

	expect(() => builder.build(null, { recentChanged: [] })).toThrow(
		/No active session transcript available/,
	);
});

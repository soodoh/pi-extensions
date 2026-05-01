import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
} from "@mariozechner/pi-coding-agent";
import { buildLatestHistoricalTurnContext } from "./app/services/conversation-signals";
import { type AppComposition, createAppComposition } from "./composition/root";
import {
	PiExtensionAdapter,
	type PiExtensionEventApi,
	type PromptSuggesterBranchEntry,
	type PromptSuggesterExtensionContext,
} from "./infra/pi/extension-adapter";
import {
	type GhostEditorInstallState,
	syncGhostEditorDecorator,
} from "./infra/pi/ghost-editor-installation";
import { refreshSuggesterUi } from "./infra/pi/ui-adapter";
import { createUiContext, type UiContextLike } from "./infra/pi/ui-context";

export type PromptSuggesterApi = PiExtensionEventApi &
	Pick<ExtensionAPI, "getThinkingLevel">;

function isObjectRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

function isAgentMessage(value: unknown): value is AgentMessage {
	if (!isObjectRecord(value)) return false;
	return (
		value.role === "user" ||
		value.role === "assistant" ||
		value.role === "toolResult"
	);
}

function isHistoricalBranchEntry(
	entry: PromptSuggesterBranchEntry,
): entry is PromptSuggesterBranchEntry & {
	type: "message";
	id: string;
	message: AgentMessage;
} {
	return (
		entry.type === "message" &&
		typeof entry.id === "string" &&
		isAgentMessage(entry.message)
	);
}

function isExtensionContext(
	ctx: PromptSuggesterExtensionContext,
): ctx is ExtensionContext {
	return "ui" in ctx;
}

export default function suggester(pi: PromptSuggesterApi) {
	const compositionPromises = new Map<string, Promise<AppComposition>>();
	const sessionManagerKeys = new WeakMap<object, string>();
	const ghostEditorInstallStateBySession = new Map<
		string,
		GhostEditorInstallState | undefined
	>();
	let nextAnonymousSessionId = 1;

	function syncGhostEditorInstallation(
		ctx: ExtensionContext,
		composition: AppComposition,
		sessionKey: string,
	): void {
		if (!ctx.hasUI) return;
		const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		const ghostEditorInstallState =
			ghostEditorInstallStateBySession.get(sessionKey);
		ghostEditorInstallStateBySession.set(
			sessionKey,
			syncGhostEditorDecorator({
				state: ghostEditorInstallState,
				context: ctx,
				sessionFile,
				options: {
					getSuggestion: () => composition.runtimeRef.getSuggestion(),
					getSuggestionRevision: () =>
						composition.runtimeRef.getSuggestionRevision(),
					ghostAcceptKeys: composition.config.suggestion.ghostAcceptKeys,
					ghostAcceptAndSendKeys:
						composition.config.suggestion.ghostAcceptAndSendKeys,
				},
			}),
		);
	}

	function resolveSessionCwd(ctx: PromptSuggesterExtensionContext): string {
		return path.resolve(ctx.sessionManager.getCwd() || process.cwd());
	}

	function resolveSessionKey(ctx: PromptSuggesterExtensionContext): string {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) return `file:${path.resolve(sessionFile)}`;
		const sessionId = ctx.sessionManager.getSessionId?.();
		if (sessionId?.trim()) return `id:${sessionId.trim()}`;
		const existing = sessionManagerKeys.get(ctx.sessionManager);
		if (existing) return existing;
		const next = `memory:${nextAnonymousSessionId}`;
		nextAnonymousSessionId += 1;
		sessionManagerKeys.set(ctx.sessionManager, next);
		return next;
	}

	function compositionKey(ctx: PromptSuggesterExtensionContext): string {
		return `${resolveSessionCwd(ctx)}\u0000${resolveSessionKey(ctx)}`;
	}

	async function getComposition(
		ctx: PromptSuggesterExtensionContext,
	): Promise<AppComposition> {
		const key = compositionKey(ctx);
		let compositionPromise = compositionPromises.get(key);
		if (!compositionPromise) {
			const cwd = resolveSessionCwd(ctx);
			compositionPromise = createAppComposition(pi, cwd).catch((error) => {
				compositionPromises.delete(key);
				throw error;
			});
			compositionPromises.set(key, compositionPromise);
		}
		return await compositionPromise;
	}

	async function setRuntimeContext(
		ctx: PromptSuggesterExtensionContext,
	): Promise<AppComposition> {
		const composition = await getComposition(ctx);
		if (isExtensionContext(ctx)) composition.runtimeRef.setContext(ctx);
		return composition;
	}

	async function clearRuntimeContext(
		ctx: PromptSuggesterExtensionContext,
	): Promise<void> {
		const key = compositionKey(ctx);
		const compositionPromise = compositionPromises.get(key);
		if (!compositionPromise) return;
		try {
			const composition = await compositionPromise;
			if (isExtensionContext(ctx)) composition.runtimeRef.clearContext(ctx);
			ghostEditorInstallStateBySession.delete(key);
		} catch {
			// If composition failed during startup, there is no runtime context to clear.
		}
	}

	function getUiContext(composition: AppComposition): UiContextLike {
		return createUiContext({
			runtimeRef: composition.runtimeRef,
			config: composition.config,
			getSessionThinkingLevel: () => pi.getThinkingLevel(),
		});
	}

	function syncSuggestionUi(
		ctx: PromptSuggesterExtensionContext,
		composition: AppComposition,
	): void {
		if (!isExtensionContext(ctx) || !ctx.hasUI) return;
		syncGhostEditorInstallation(ctx, composition, resolveSessionKey(ctx));
		refreshSuggesterUi(getUiContext(composition));
	}

	pi.on("session_shutdown", async (_event, ctx) => {
		await clearRuntimeContext(ctx);
	});

	const adapter = new PiExtensionAdapter(pi, {
		onSessionStart: async (ctx) => {
			const composition = await setRuntimeContext(ctx);
			const generationId = composition.runtimeRef.bumpEpoch();
			syncSuggestionUi(ctx, composition);
			await composition.orchestrators.sessionStart.handle();

			const sourceLeafId =
				ctx.sessionManager.getLeafId() ?? `turn-${Date.now()}`;
			if (composition.runtimeRef.getLastBootstrappedLeafId() === sourceLeafId)
				return;

			const state = await composition.stores.stateStore.load();
			if (state.lastSuggestion?.turnId === sourceLeafId) {
				composition.runtimeRef.markBootstrappedLeafId(sourceLeafId);
				return;
			}

			const branchEntries = ctx.sessionManager
				.getBranch()
				.filter(isHistoricalBranchEntry);
			const historicalTurn = buildLatestHistoricalTurnContext({
				branchEntries,
			});
			if (!historicalTurn) return;

			composition.runtimeRef.markBootstrappedLeafId(sourceLeafId);
			composition.runtimeRef.setLastTurnContext(historicalTurn);
			await composition.orchestrators.agentEnd.handle(
				historicalTurn,
				generationId,
			);
		},
		onAgentEnd: async (turn, ctx) => {
			if (!turn) return;
			const composition = await setRuntimeContext(ctx);
			syncSuggestionUi(ctx, composition);
			composition.runtimeRef.setLastTurnContext(turn);
			const generationId = composition.runtimeRef.bumpEpoch();
			await composition.orchestrators.agentEnd.handle(turn, generationId);
		},
		onUserSubmit: async (event: InputEvent, ctx) => {
			const composition = await setRuntimeContext(ctx);
			syncSuggestionUi(ctx, composition);
			composition.runtimeRef.bumpEpoch();
			await composition.orchestrators.userSubmit.handle({
				turnId: ctx.sessionManager.getLeafId() ?? `input-${Date.now()}`,
				userPrompt: event.text,
				source: event.source,
			});
		},
	});

	adapter.register();
}

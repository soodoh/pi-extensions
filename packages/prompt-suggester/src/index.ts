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
	let ghostEditorInstallState: GhostEditorInstallState | undefined;

	function syncGhostEditorInstallation(
		ctx: ExtensionContext,
		composition: AppComposition,
	): void {
		if (!ctx.hasUI) return;
		const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
		ghostEditorInstallState = syncGhostEditorDecorator({
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
		});
	}

	function resolveSessionCwd(ctx: PromptSuggesterExtensionContext): string {
		return path.resolve(ctx.sessionManager.getCwd() || process.cwd());
	}

	async function getComposition(cwd: string): Promise<AppComposition> {
		let compositionPromise = compositionPromises.get(cwd);
		if (!compositionPromise) {
			compositionPromise = createAppComposition(pi, cwd).catch((error) => {
				compositionPromises.delete(cwd);
				throw error;
			});
			compositionPromises.set(cwd, compositionPromise);
		}
		return await compositionPromise;
	}

	async function setRuntimeContext(
		ctx: PromptSuggesterExtensionContext,
	): Promise<AppComposition> {
		const composition = await getComposition(resolveSessionCwd(ctx));
		if (isExtensionContext(ctx)) composition.runtimeRef.setContext(ctx);
		return composition;
	}

	async function clearRuntimeContext(
		ctx: PromptSuggesterExtensionContext,
	): Promise<void> {
		const compositionPromise = compositionPromises.get(resolveSessionCwd(ctx));
		if (!compositionPromise) return;
		try {
			const composition = await compositionPromise;
			if (isExtensionContext(ctx)) composition.runtimeRef.clearContext(ctx);
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
		syncGhostEditorInstallation(ctx, composition);
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

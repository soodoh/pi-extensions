import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { CustomEditor } from "@mariozechner/pi-coding-agent";

import {
	appendPrompt,
	getPromptHistoryPath,
	readPromptHistory,
} from "./history-store";

type EditorFactory = NonNullable<
	Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0]
>;

type HistoryCapableEditor = ReturnType<EditorFactory> & {
	addToHistory?: (text: string) => void;
	onSubmit?: (text: string) => void | Promise<void>;
};

interface SharedPromptHistoryState {
	loaded: boolean;
	lastPersistedPrompt: string | undefined;
	persistQueue: Promise<void>;
	wrappedSubmit: ((text: string) => void | Promise<void>) | undefined;
}

const sharedPromptHistoryState = Symbol("sharedPromptHistoryState");

interface SharedPromptHistoryOptions {
	historyPath?: string;
	home?: string;
}

type SharedPromptHistoryContext = {
	ui: Pick<ExtensionContext["ui"], "setEditorComponent">;
};

type SharedPromptHistoryApi = {
	on(
		event: "session_start",
		handler: (
			event: unknown,
			ctx: SharedPromptHistoryContext,
		) => void | Promise<void>,
	): void;
};

class SharedPromptHistoryEditor extends CustomEditor {}

function getState(editor: HistoryCapableEditor): SharedPromptHistoryState {
	const state = Reflect.get(editor, sharedPromptHistoryState) as
		| SharedPromptHistoryState
		| undefined;
	if (state) return state;

	const nextState: SharedPromptHistoryState = {
		loaded: false,
		lastPersistedPrompt: undefined,
		persistQueue: Promise.resolve(),
		wrappedSubmit: undefined,
	};
	Reflect.set(editor, sharedPromptHistoryState, nextState);
	return nextState;
}

function loadHistory(editor: HistoryCapableEditor, prompts: string[]): void {
	const state = getState(editor);
	if (state.loaded || typeof editor.addToHistory !== "function") return;

	for (const prompt of prompts) {
		editor.addToHistory(prompt);
		state.lastPersistedPrompt = prompt.trim();
	}
	state.loaded = true;
}

async function persistPrompt(
	editor: HistoryCapableEditor,
	text: string,
	historyPath: string,
): Promise<void> {
	const state = getState(editor);
	const trimmed = text.trim();
	if (!trimmed || trimmed === state.lastPersistedPrompt) return;

	const previousPrompt = state.lastPersistedPrompt;
	state.lastPersistedPrompt = trimmed;
	try {
		await appendPrompt(trimmed, historyPath, {
			lastPersistedPrompt: previousPrompt,
		});
	} catch {
		if (state.lastPersistedPrompt === trimmed) {
			state.lastPersistedPrompt = previousPrompt;
		}
		// Prompt history should never interfere with submitting a message.
	}
}

function wrapOnSubmit(editor: HistoryCapableEditor, historyPath: string): void {
	const state = getState(editor);
	const original = editor.onSubmit;
	if (!original || original === state.wrappedSubmit) return;

	state.wrappedSubmit = (text: string) => {
		state.persistQueue = state.persistQueue.then(
			() => persistPrompt(editor, text, historyPath),
			() => persistPrompt(editor, text, historyPath),
		);
		void state.persistQueue;
		return original(text);
	};
	editor.onSubmit = state.wrappedSubmit;
}

function enhanceEditor(
	editor: HistoryCapableEditor,
	prompts: string[],
	historyPath: string,
): void {
	loadHistory(editor, prompts);

	// pi wires onSubmit immediately after an editor factory returns. Wrap it on the
	// next microtask so built-in slash commands are persisted too, not only paths
	// where pi later calls addToHistory().
	queueMicrotask(() => wrapOnSubmit(editor, historyPath));
}

export default function sharedPromptHistory(
	pi: SharedPromptHistoryApi,
	options: SharedPromptHistoryOptions = {},
) {
	pi.on("session_start", async (_event, ctx) => {
		const historyPath =
			options.historyPath ?? getPromptHistoryPath({ home: options.home });
		const history = await readPromptHistory(historyPath);

		const originalSetEditorComponent = ctx.ui.setEditorComponent.bind(ctx.ui);
		ctx.ui.setEditorComponent = (factory) => {
			originalSetEditorComponent(
				factory
					? (tui, theme, keybindings) => {
							const editor = factory(
								tui,
								theme,
								keybindings,
							) as HistoryCapableEditor;
							enhanceEditor(editor, history, historyPath);
							return editor;
						}
					: undefined,
			);
		};

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = new SharedPromptHistoryEditor(tui, theme, keybindings);
			enhanceEditor(editor, history, historyPath);
			return editor;
		});
	});
}

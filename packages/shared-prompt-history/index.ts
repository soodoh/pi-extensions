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

type EditorInstance = ReturnType<EditorFactory>;

type SubmitHandler = (text: string) => void | Promise<void>;

interface SharedPromptHistoryState {
	loaded: boolean;
	lastPersistedPrompt: string | undefined;
	persistQueue: Promise<void>;
	wrappedSubmit: SubmitHandler | undefined;
}

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

const editorStates = new WeakMap<object, SharedPromptHistoryState>();

function getState(editor: EditorInstance): SharedPromptHistoryState {
	const state = editorStates.get(editor);
	if (state) return state;

	const nextState: SharedPromptHistoryState = {
		loaded: false,
		lastPersistedPrompt: undefined,
		persistQueue: Promise.resolve(),
		wrappedSubmit: undefined,
	};
	editorStates.set(editor, nextState);
	return nextState;
}

function getSubmitHandler(editor: EditorInstance): SubmitHandler | undefined {
	const value = Reflect.get(editor, "onSubmit");
	return typeof value === "function" ? value.bind(editor) : undefined;
}

function setSubmitHandler(
	editor: EditorInstance,
	handler: SubmitHandler,
): void {
	Reflect.set(editor, "onSubmit", handler);
}

function loadHistory(editor: EditorInstance, prompts: string[]): void {
	const state = getState(editor);
	const addToHistory = Reflect.get(editor, "addToHistory");
	if (state.loaded || typeof addToHistory !== "function") return;

	for (const prompt of prompts) {
		addToHistory.call(editor, prompt);
		state.lastPersistedPrompt = prompt.trim();
	}
	state.loaded = true;
}

async function persistPrompt(
	editor: EditorInstance,
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

function wrapOnSubmit(editor: EditorInstance, historyPath: string): void {
	const state = getState(editor);
	const original = getSubmitHandler(editor);
	if (!original || original === state.wrappedSubmit) return;

	state.wrappedSubmit = (text: string) => {
		state.persistQueue = state.persistQueue.then(
			() => persistPrompt(editor, text, historyPath),
			() => persistPrompt(editor, text, historyPath),
		);
		void state.persistQueue;
		return original(text);
	};
	setSubmitHandler(editor, state.wrappedSubmit);
}

function enhanceEditor(
	editor: EditorInstance,
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
							const editor = factory(tui, theme, keybindings);
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

import { expect, test } from "vitest";
import { syncGhostEditorDecorator } from "../../../src/infra/pi/ghost-editor-installation";
import { decorateGhostSuggestionEditor } from "../../../src/infra/pi/ghost-suggestion-decorator";

function createOptions(overrides = {}) {
	let active = overrides.active ?? true;
	let suggestion = overrides.suggestion ?? "hello world";
	let revision = overrides.revision ?? 1;
	return {
		options: {
			getSuggestion: () => suggestion,
			getSuggestionRevision: () => revision,
			ghostAcceptKeys: overrides.ghostAcceptKeys ?? ["right"],
			ghostAcceptAndSendKeys: overrides.ghostAcceptAndSendKeys ?? ["enter"],
			isActive: () => active,
		},
		setActive(next) {
			active = next;
		},
		setSuggestion(next) {
			suggestion = next;
			revision += 1;
		},
	};
}

function createFakeEditor() {
	return {
		text: "",
		cursor: { line: 0, col: 0 },
		inputs: [],
		submitted: [],
		handleInput(data) {
			this.inputs.push(data);
			if (data === "\r") {
				this.submitted.push(this.text);
				this.setText("");
				return;
			}
			this.setText(`${this.text}${data}`);
		},
		render() {
			return ["top", ` ${this.text}\x1b[7m \x1b[27m`, "bottom"];
		},
		getText() {
			return this.text;
		},
		getCursor() {
			return this.cursor;
		},
		setText(text) {
			this.text = text;
			this.cursor = { line: 0, col: text.length };
		},
	};
}

test("ghost decorator preserves the editor and delegates non-accept input", () => {
	const state = createOptions();
	const editor = createFakeEditor();
	const decorated = decorateGhostSuggestionEditor(editor, () => state.options);

	expect(decorated).toBe(editor);
	decorated.handleInput("x");

	expect(editor.inputs).toEqual(["x"]);
	expect(editor.getText()).toBe("x");
});

test("ghost decorator accepts suggestion without replacing editor behavior", () => {
	const state = createOptions();
	const editor = createFakeEditor();
	const decorated = decorateGhostSuggestionEditor(editor, () => state.options);

	decorated.handleInput("\x1b[C");

	expect(editor.getText()).toBe("hello world");
	expect(editor.inputs).toEqual([]);
});

test("ghost decorator accept-and-send materializes suggestion then delegates submit key", () => {
	const state = createOptions();
	const editor = createFakeEditor();
	const decorated = decorateGhostSuggestionEditor(editor, () => state.options);

	decorated.handleInput("\r");

	expect(editor.inputs).toEqual(["\r"]);
	expect(editor.submitted).toEqual(["hello world"]);
	expect(editor.getText()).toBe("");
});

test("ghost decorator can be deactivated without replacing the editor", () => {
	const state = createOptions({ active: false });
	const editor = createFakeEditor();
	const decorated = decorateGhostSuggestionEditor(editor, () => state.options);

	decorated.handleInput("\x1b[C");

	expect(editor.inputs).toEqual(["\x1b[C"]);
	expect(editor.getText()).not.toBe("hello world");
});

test("ghost decorator installation wraps future editor factories instead of reinstalling on every sync", () => {
	const originalSetEditorCalls = [];
	const ctx = {
		ui: {
			setEditorComponent(factory) {
				originalSetEditorCalls.push(factory);
			},
		},
	};
	const state = createOptions();
	let installState: ReturnType<typeof syncGhostEditorDecorator>;

	installState = syncGhostEditorDecorator({
		state: installState,
		context: ctx,
		sessionFile: "/tmp/session.json",
		options: state.options,
	});
	expect(originalSetEditorCalls.length).toBe(1);

	installState = syncGhostEditorDecorator({
		state: installState,
		context: ctx,
		sessionFile: "/tmp/session.json",
		options: state.options,
	});
	expect(originalSetEditorCalls.length).toBe(1);

	const externalEditor = createFakeEditor();
	ctx.ui.setEditorComponent(() => externalEditor);
	expect(originalSetEditorCalls.length).toBe(2);

	const wrappedFactory = originalSetEditorCalls[1];
	const wrappedEditor = wrappedFactory({}, {}, {});
	expect(wrappedEditor).toBe(externalEditor);

	wrappedEditor.handleInput("\x1b[C");
	expect(externalEditor.getText()).toBe("hello world");
});

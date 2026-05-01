import path from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import { INITIAL_RUNTIME_STATE } from "../src/domain/state";

const compositionCwds = vi.hoisted((): string[] => []);
const createAppCompositionMock = vi.hoisted(() =>
	vi.fn(async (_pi: unknown, cwd = process.cwd()) => {
		compositionCwds.push(cwd);
		return {
			config: {
				suggestion: {
					ghostAcceptKeys: ["right"],
					ghostAcceptAndSendKeys: ["enter"],
				},
			},
			runtimeRef: {
				setContext() {},
				clearContext() {},
				bumpEpoch() {
					return 1;
				},
				getSuggestion() {
					return undefined;
				},
				getSuggestionRevision() {
					return 0;
				},
				getLastBootstrappedLeafId() {
					return undefined;
				},
				markBootstrappedLeafId() {},
				setLastTurnContext() {},
			},
			stores: {
				seedStore: {},
				stateStore: {
					async load() {
						return INITIAL_RUNTIME_STATE;
					},
				},
			},
			eventLog: {},
			orchestrators: {
				sessionStart: { async handle() {} },
				agentEnd: { async handle() {} },
				userSubmit: { async handle() {} },
				reseedRunner: { async trigger() {} },
			},
		};
	}),
);

vi.mock("../src/composition/root", () => ({
	createAppComposition: createAppCompositionMock,
}));

const { default: suggester } = await import("../src/index");

type PromptSuggesterApi = Parameters<typeof suggester>[0];
type ApiHandler = Parameters<PromptSuggesterApi["on"]>[1];
type SessionContext = Parameters<ApiHandler>[1];
type Handler = (
	event: unknown,
	ctx: SessionContext,
) => unknown | Promise<unknown>;

function createPi() {
	const handlers = new Map<string, Handler>();
	return {
		handlers,
		on(eventName: string, handler: Handler) {
			handlers.set(eventName, handler);
		},
		getThinkingLevel(): ReturnType<PromptSuggesterApi["getThinkingLevel"]> {
			return "off";
		},
	};
}

function createContext(cwd: string): SessionContext {
	return {
		hasUI: false,
		sessionManager: {
			getCwd() {
				return cwd;
			},
			getSessionFile() {
				return undefined;
			},
			getLeafId() {
				return "leaf-1";
			},
			getBranch() {
				return [];
			},
		},
	};
}

beforeEach(() => {
	compositionCwds.length = 0;
	createAppCompositionMock.mockClear();
});

test("prompt suggester caches app composition by active session cwd", async () => {
	const firstCwd = path.resolve("/tmp/project-one");
	const secondCwd = path.resolve("/tmp/project-two");
	const pi = createPi();
	suggester(pi);

	await pi.handlers.get("session_start")?.({}, createContext(firstCwd));
	await pi.handlers.get("session_start")?.({}, createContext(firstCwd));
	await pi.handlers.get("session_start")?.({}, createContext(secondCwd));

	expect(compositionCwds).toEqual([firstCwd, secondCwd]);
	expect(createAppCompositionMock).toHaveBeenNthCalledWith(1, pi, firstCwd);
	expect(createAppCompositionMock).toHaveBeenNthCalledWith(2, pi, secondCwd);
});

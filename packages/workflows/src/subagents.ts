import type { ThinkingLevel } from "./workflow-types";

const REQUEST = "subagent:slash:request";
const RESPONSE = "subagent:slash:response";

export interface SubagentRunParams {
	agent?: string;
	task?: string;
	tasks?: Array<{
		agent: string;
		task: string;
		model?: string;
		thinking?: ThinkingLevel;
		output?: string | boolean;
	}>;
	context?: "fresh" | "fork";
	concurrency?: number;
	worktree?: boolean;
	model?: string;
	thinking?: ThinkingLevel;
}

type SubagentEventsApi = {
	events: {
		on(
			event: typeof RESPONSE,
			handler: (response: SubagentResponse) => void,
		): (() => void) | void;
		emit(event: typeof REQUEST, payload: unknown): void;
	};
};

type SubagentResponse = {
	requestId?: string;
	isError?: boolean;
	errorText?: string;
	result?: unknown;
};

export function runSubagents(
	pi: SubagentEventsApi,
	params: SubagentRunParams,
	timeoutMs = 60 * 60 * 1000,
): Promise<unknown> {
	const requestId = `pwf-subagent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return new Promise((resolve, reject) => {
		const off = pi.events.on(RESPONSE, (response) => {
			if (response.requestId !== requestId) return;
			cleanup();
			if (response.isError)
				reject(new Error(response.errorText ?? "subagent run failed"));
			else resolve(response.result);
		});
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Timed out waiting for subagent response"));
		}, timeoutMs);
		function cleanup() {
			clearTimeout(timer);
			if (typeof off === "function") off();
		}
		pi.events.emit(REQUEST, {
			requestId,
			params: { ...params, clarify: false, async: false },
		});
	});
}

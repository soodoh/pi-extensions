import type { ThinkingLevel } from "./types";

export function toInvocationThinkingLevel(
	value: string,
): ThinkingLevel | undefined {
	return value === "session-default" ? undefined : (value as ThinkingLevel);
}

import { describe, expect, test, vi } from "vitest";
import { type EventsLike, requestViaEvent, waitForEvent } from "./pi-events";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("pi event helpers", () => {
	test("requestViaEvent emits a request with a responder and resolves response", async () => {
		let emittedChannel = "";
		let emittedPayload: unknown;
		const events: EventsLike = {
			emit(channel, payload) {
				emittedChannel = channel;
				emittedPayload = payload;
			},
			on() {
				return undefined;
			},
		};

		const responsePromise = requestViaEvent(
			events,
			"workflow:test",
			{ value: 1 },
			1000,
		);

		expect(emittedChannel).toBe("workflow:test");
		expect(emittedPayload).toMatchObject({ value: 1 });
		if (!isRecord(emittedPayload)) throw new Error("expected object payload");
		expect(typeof emittedPayload.requestId).toBe("string");
		const respond = emittedPayload.respond;
		if (typeof respond !== "function") throw new Error("expected responder");

		respond({ ok: true });

		await expect(responsePromise).resolves.toEqual({ ok: true });
	});

	test("waitForEvent ignores non-matching events and unsubscribes after match", async () => {
		let handler: ((data: unknown) => void) | undefined;
		const off = vi.fn();
		const events: EventsLike = {
			emit() {},
			on(channel, nextHandler) {
				expect(channel).toBe("workflow:done");
				handler = nextHandler;
				return off;
			},
		};

		const waiting = waitForEvent(
			events,
			"workflow:done",
			(event): event is { ok: true } => isRecord(event) && event.ok === true,
			1000,
		);

		handler?.({ ok: false });
		expect(off).not.toHaveBeenCalled();
		handler?.({ ok: true });

		await expect(waiting).resolves.toEqual({ ok: true });
		expect(off).toHaveBeenCalledTimes(1);
	});

	test("waitForEvent times out and cleans up subscription", async () => {
		vi.useFakeTimers();
		const off = vi.fn();
		const events: EventsLike = {
			emit() {},
			on() {
				return off;
			},
		};

		const waiting = waitForEvent(
			events,
			"workflow:missing",
			(event): event is { ok: true } => isRecord(event) && event.ok === true,
			50,
		);
		const rejection = expect(waiting).rejects.toThrow(
			/Timed out waiting for workflow:missing/,
		);
		await vi.advanceTimersByTimeAsync(50);

		await rejection;
		expect(off).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});

import { expect, test } from "vitest";
import type { EventsLike } from "./pi-events";
import { reviewPlanWithPlannotator } from "./plannotator";

test("reviewPlanWithPlannotator sends plan-review request on plannotator channel", async () => {
	let observedChannel = "";
	let observedPayload: unknown;
	let resultHandler: ((event: unknown) => void) | undefined;
	const events: EventsLike = {
		emit(channel, payload) {
			observedChannel = channel;
			observedPayload = payload;
			if (
				payload &&
				typeof payload === "object" &&
				"respond" in payload &&
				typeof payload.respond === "function"
			) {
				payload.respond({
					status: "handled",
					result: { status: "pending", reviewId: "review-123" },
				});
				setTimeout(() => {
					resultHandler?.({ reviewId: "review-123", approved: true });
				}, 0);
			}
		},
		on(channel, handler) {
			expect(channel).toBe("plannotator:review-result");
			resultHandler = handler;
			return () => {
				resultHandler = undefined;
			};
		},
	};

	await expect(
		reviewPlanWithPlannotator(eventsApi(events), "/tmp/plan.md", "# Plan"),
	).resolves.toMatchObject({ reviewId: "review-123", approved: true });

	expect(observedChannel).toBe("plannotator:request");
	expect(observedPayload).toMatchObject({
		action: "plan-review",
		payload: {
			planContent: "# Plan",
			planFilePath: "/tmp/plan.md",
			origin: "pi-workflows",
		},
	});
});

test("reviewPlanWithPlannotator rejects malformed request responses", async () => {
	const events: EventsLike = {
		emit(_channel, payload) {
			if (
				payload &&
				typeof payload === "object" &&
				"respond" in payload &&
				typeof payload.respond === "function"
			) {
				payload.respond({ status: "handled", result: { status: "done" } });
			}
		},
		on() {
			throw new Error("should not wait for review result");
		},
	};

	await expect(
		reviewPlanWithPlannotator(eventsApi(events), "/tmp/plan.md", "# Plan"),
	).rejects.toThrow(/Plannotator plan-review unavailable/);
});

test("reviewPlanWithPlannotator ignores non-matching review events", async () => {
	let resultHandler: ((event: unknown) => void) | undefined;
	const events: EventsLike = {
		emit(_channel, payload) {
			if (
				payload &&
				typeof payload === "object" &&
				"respond" in payload &&
				typeof payload.respond === "function"
			) {
				payload.respond({
					status: "handled",
					result: { status: "pending", reviewId: "wanted-review" },
				});
				setTimeout(() => {
					resultHandler?.({
						reviewId: "other-review",
						approved: false,
						feedback: "wrong",
					});
					resultHandler?.({
						reviewId: "wanted-review",
						approved: true,
						feedback: "ship it",
						savedPath: "/tmp/reviewed.md",
					});
				}, 0);
			}
		},
		on(_channel, handler) {
			resultHandler = handler;
			return () => {
				resultHandler = undefined;
			};
		},
	};

	await expect(
		reviewPlanWithPlannotator(eventsApi(events), "/tmp/plan.md", "# Plan"),
	).resolves.toEqual({
		reviewId: "wanted-review",
		approved: true,
		feedback: "ship it",
		savedPath: "/tmp/reviewed.md",
	});
});

function eventsApi(events: EventsLike): { events: EventsLike } {
	return { events };
}

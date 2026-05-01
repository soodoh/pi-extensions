import { readFile } from "node:fs/promises";
import { type EventsLike, requestViaEvent, waitForEvent } from "./pi-events";

const REQUEST = "plannotator:request";
const RESULT = "plannotator:review-result";

export interface PlanReviewResult {
	approved: boolean;
	feedback?: string;
	savedPath?: string;
	reviewId: string;
}

type PlannotatorPiApi = {
	events: EventsLike;
};

type PlannotatorRequestResponse = {
	status: "handled";
	result: {
		status: "pending";
		reviewId: string;
	};
};

type PlannotatorReviewEvent = {
	reviewId: string;
	approved?: boolean;
	feedback?: string;
	savedPath?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseRequestResponse(response: unknown): PlannotatorRequestResponse {
	if (!isRecord(response)) {
		throw new Error("Plannotator plan-review unavailable");
	}
	if (response.status !== "handled" || !isRecord(response.result)) {
		throw new Error(
			typeof response.error === "string"
				? response.error
				: "Plannotator plan-review unavailable",
		);
	}
	if (
		response.result.status !== "pending" ||
		typeof response.result.reviewId !== "string"
	) {
		throw new Error("Plannotator plan-review unavailable");
	}
	return {
		status: "handled",
		result: {
			status: "pending",
			reviewId: response.result.reviewId,
		},
	};
}

function isReviewEventFor(
	reviewId: string,
): (event: unknown) => event is PlannotatorReviewEvent {
	return (event: unknown): event is PlannotatorReviewEvent =>
		isRecord(event) && event.reviewId === reviewId;
}

export async function reviewPlanWithPlannotator(
	pi: PlannotatorPiApi,
	filePath: string,
	planContent?: string,
): Promise<PlanReviewResult> {
	const content = planContent ?? (await readFile(filePath, "utf8"));
	const response = parseRequestResponse(
		await requestViaEvent(
			pi.events,
			REQUEST,
			{
				action: "plan-review",
				payload: {
					planContent: content,
					planFilePath: filePath,
					origin: "pi-workflows",
				},
			},
			10_000,
		),
	);
	const reviewId = response.result.reviewId;
	const result = await waitForEvent(
		pi.events,
		RESULT,
		isReviewEventFor(reviewId),
	);
	return {
		reviewId,
		approved: result.approved === true,
		feedback: result.feedback,
		savedPath: result.savedPath,
	};
}

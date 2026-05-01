import { describe, expect, test } from "vitest";
import { parseApprovePlanToolInput, parseSubmitPlanToolInput } from "../index";

describe("workflow tool parsers", () => {
	test("submit parser rejects approval-only notes", () => {
		expect(() =>
			parseSubmitPlanToolInput({
				runId: "pwf-11111111",
				filePath: "plan.md",
				approvalNotes: "approved in chat",
			}),
		).toThrow(/submit schema/);
	});

	test("approve parser accepts approval notes", () => {
		expect(
			parseApprovePlanToolInput({
				runId: "pwf-11111111",
				filePath: "plan.md",
				approvalNotes: "approved in chat",
			}),
		).toEqual({
			runId: "pwf-11111111",
			filePath: "plan.md",
			approvalNotes: "approved in chat",
		});
	});

	test("plan parsers reject traversal-shaped run ids", () => {
		expect(() =>
			parseSubmitPlanToolInput({
				runId: "../pwf-11111111",
				filePath: "plan.md",
			}),
		).toThrow(/submit schema/);
		expect(() =>
			parseApprovePlanToolInput({ runId: "pwf-../bad", filePath: "plan.md" }),
		).toThrow(/approval schema/);
	});
});

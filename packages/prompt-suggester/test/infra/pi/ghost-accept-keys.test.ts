import { expect, test } from "vitest";
import {
	matchesGhostAcceptKey,
	normalizeGhostAcceptAndSendKeys,
} from "../../../src/infra/pi/ghost-accept-keys";

test("normalizeGhostAcceptAndSendKeys defaults to enter", () => {
	expect(normalizeGhostAcceptAndSendKeys(undefined)).toEqual(["enter"]);
	expect(normalizeGhostAcceptAndSendKeys(["space"])).toEqual(["space"]);
});

test("matchesGhostAcceptKey recognizes enter input", () => {
	expect(matchesGhostAcceptKey("\r", ["enter"])).toBe(true);
	expect(matchesGhostAcceptKey("\n", ["enter"])).toBe(true);
	expect(matchesGhostAcceptKey("\r", ["space"])).toBe(false);
});

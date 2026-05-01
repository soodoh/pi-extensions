import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { NdjsonEventLog } from "../../../src/infra/logging/ndjson-event-log";

test("NdjsonEventLog writes event logs with private permissions", async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-suggester-events-"));
	const filePath = path.join(dir, "logs", "events.ndjson");
	const log = new NdjsonEventLog(filePath);

	await log.append({
		at: "2026-05-01T00:00:00.000Z",
		level: "info",
		message: "test.event",
	});

	expect((await stat(path.dirname(filePath))).mode & 0o777).toBe(0o700);
	expect((await stat(filePath)).mode & 0o777).toBe(0o600);
});

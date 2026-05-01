import { expect, test } from "vitest";
import type { EventLog } from "../../../src/app/ports/event-log";
import { ConsoleLogger } from "../../../src/infra/logging/console-logger";

test("ConsoleLogger applies level threshold before appending to event log", async () => {
	const events: Array<{ level: string; message: string }> = [];
	const eventLog: EventLog = {
		async append(event) {
			events.push({ level: event.level, message: event.message });
		},
	};
	const logger = new ConsoleLogger("info", {
		eventLog,
		mirrorToConsoleWhenNoUi: false,
	});

	logger.debug("provider.payload", { token: "secret" });
	logger.info("visible.event");
	await new Promise((resolve) => setImmediate(resolve));

	expect(events).toEqual([{ level: "info", message: "visible.event" }]);
});

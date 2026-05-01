export type EventsLike = {
	emit(channel: string, payload: unknown): void;
	on(
		channel: string,
		handler: (data: unknown) => void,
	): undefined | (() => void);
};

export function requestViaEvent(
	events: EventsLike,
	channel: string,
	request: Record<string, unknown>,
	timeoutMs = 10_000,
): Promise<unknown> {
	const requestId = `pwf-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`Timed out waiting for ${channel}`)),
			timeoutMs,
		);
		const payload = {
			...request,
			requestId,
			respond: (response: unknown) => {
				clearTimeout(timeout);
				resolve(response);
			},
		};
		events.emit(channel, payload);
	});
}

export function waitForEvent<T>(
	events: EventsLike,
	channel: string,
	predicate: (event: unknown) => event is T,
	timeoutMs = 24 * 60 * 60 * 1000,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const off = events.on(channel, (data: unknown) => {
			if (!predicate(data)) return;
			cleanup();
			resolve(data);
		});
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for ${channel}`));
		}, timeoutMs);
		function cleanup() {
			clearTimeout(timer);
			if (typeof off === "function") off();
		}
	});
}

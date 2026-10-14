import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ModelRegistry = Pick<ExtensionContext["modelRegistry"], "streamSimple">;
type Reply = ReturnType<ModelRegistry["streamSimple"]>;
type Usage = Awaited<ReturnType<Reply["result"]>>["usage"];

/** One provider request, with the payload exactly as pi handed it to the provider. */
export interface SentRequest {
	model: NonNullable<ExtensionContext["model"]>;
	payload: unknown;
	sessionId: string | undefined;
	sentAt: number;
}

export interface KeepalivePing {
	/** Since the request or the previous ping was sent. */
	sincePreviousMs: number;
	/** Why the model did not start its reply; the cache entry was then probably not renewed. */
	error?: string;
	/** Token usage, when the provider reported it before the abort. */
	usage?: Usage;
}

async function replay(request: SentRequest, registry: ModelRegistry, controller: AbortController): Promise<Omit<KeepalivePing, "sincePreviousMs">> {
	const reply = registry.streamSimple(request.model, { messages: [] }, { onPayload: () => structuredClone(request.payload), sessionId: request.sessionId, signal: controller.signal, maxRetries: 0 });
	let modelStartedReply = false;
	for await (const event of reply) {
		if (event.type === "start") continue;
		modelStartedReply = event.type !== "error";
		controller.abort();
		break;
	}
	const message = await reply.result();
	const { usage } = message;
	const usageReported = usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
	return { error: modelStartedReply ? undefined : (message.errorMessage ?? message.stopReason), usage: usageReported ? usage : undefined };
}

/**
 * Re-sends `request` `intervalMs` after it was sent, and again `intervalMs` after each ping, until the returned function is called.
 * The provider receives the same body, so it reads the request's prompt cache entry and renews its lifetime.
 * A ping is aborted at its first event after `start`: `start` only means that the HTTP response began,
 * which a router such as OpenRouter sends before the model has read the prompt.
 */
export function keepWarm(request: SentRequest, intervalMs: number, registry: ModelRegistry, onPing: (ping: KeepalivePing) => void): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pingInFlight: AbortController | undefined;
	let lastSentAt = request.sentAt;

	const ping = () => {
		pingInFlight?.abort();
		const controller = new AbortController();
		pingInFlight = controller;
		const sentAt = Date.now();
		const sincePreviousMs = sentAt - lastSentAt;
		lastSentAt = sentAt;
		scheduleNextPing();
		replay(request, registry, controller).then(
			(outcome) => onPing({ sincePreviousMs, ...outcome }),
			(error: unknown) => onPing({ sincePreviousMs, error: error instanceof Error ? error.message : String(error) }),
		);
	};
	const scheduleNextPing = () => {
		timer = setTimeout(ping, Math.max(0, lastSentAt + intervalMs - Date.now()));
		timer.unref?.();
	};

	scheduleNextPing();
	return () => {
		clearTimeout(timer);
		pingInFlight?.abort();
	};
}

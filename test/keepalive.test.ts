import { type Api, type AssistantMessageEventStream, type Context, type Model, normalizeContext, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type KeepalivePing, keepWarm } from "../src/keepalive.ts";

type ProviderStream = (model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions) => AssistantMessageEventStream;
type Reply = { chunks: string[]; openUntilAborted?: boolean };

const INTERVAL_MS = 290_000;
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * A provider behind pi's own HTTP client: records each request, answers with headers at once,
 * as OpenRouter does, and streams the reply chunks after that.
 */
function fakeProvider(replies: Reply[]) {
	const requests: { body: string; headers: Headers; chunksBeforeAbort?: number }[] = [];
	const encoder = new TextEncoder();
	const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
		const request: (typeof requests)[number] = { body: await new Response(init?.body).text(), headers: new Headers(init?.headers) };
		requests.push(request);
		const reply = replies[requests.length - 1]!;
		let deliveredChunks = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				init?.signal?.addEventListener("abort", () => {
					request.chunksBeforeAbort = deliveredChunks;
					controller.error(new DOMException("The operation was aborted.", "AbortError"));
				});
				void (async () => {
					for (const chunk of reply.chunks) {
						await new Promise((resolve) => setTimeout(resolve, 1));
						if (init?.signal?.aborted) return;
						controller.enqueue(encoder.encode(chunk));
						deliveredChunks++;
					}
					if (!reply.openUntilAborted) controller.close();
				})();
			},
		});
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return { requests, fetch };
}

const anthropicEvent = (data: { type: string } & Record<string, unknown>) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const anthropicMessageStart = (usage: Record<string, number>) =>
	anthropicEvent({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "anthropic/claude-opus-5.5", content: [], stop_reason: null, stop_sequence: null, usage } });
const completionChunk = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
	`data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 1, model: "z-ai/glm-5.3-flash", choices: [{ index: 0, ...choice }], ...extra })}\n\n`;

const providerCases = [
	{
		api: "anthropic-messages",
		model: getBuiltinModel("openrouter", "anthropic/claude-opus-5.5") as Model<Api>,
		stream: streamAnthropicMessages as ProviderStream,
		leadReply: {
			chunks: [
				anthropicMessageStart({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 40_000 }),
				anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
				anthropicEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }),
				anthropicEvent({ type: "content_block_stop", index: 0 }),
				anthropicEvent({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
				anthropicEvent({ type: "message_stop" }),
			],
		},
		pingReply: {
			chunks: [
				anthropicMessageStart({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 0 }),
				anthropicEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
			],
			openUntilAborted: true,
		},
		pingUsage: { input: 10, cacheRead: 40_000, cacheWrite: 0 },
	},
	{
		api: "openai-completions",
		model: getBuiltinModel("openrouter", "z-ai/glm-5.3-flash") as Model<Api>,
		stream: streamOpenAICompletions as ProviderStream,
		leadReply: {
			chunks: [
				completionChunk({ delta: { role: "assistant", content: "Done." } }),
				completionChunk({ delta: {}, finish_reason: "stop" }, { usage: { prompt_tokens: 40_010, completion_tokens: 3, total_tokens: 40_013 } }),
				"data: [DONE]\n\n",
			],
		},
		pingReply: { chunks: [completionChunk({ delta: { role: "assistant", content: "" } }), completionChunk({ delta: { reasoning: "The board" } })], openUntilAborted: true },
		pingUsage: undefined,
	},
];

function leadContext(model: Model<Api>): Context {
	return {
		systemPrompt: "You are the lead model.",
		messages: [
			{ role: "user", content: "Build tetris", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Reading the board first." },
					{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "src/board.ts" } },
				],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: NO_USAGE,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{ role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "export const board = [];" }], isError: false, timestamp: 3 },
		],
		tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
	};
}

describe("keepalive through pi's providers", () => {
	it.each(providerCases)("replays the lead request byte for byte through $api and aborts at the first model event", async ({ model, stream, leadReply, pingReply, pingUsage }) => {
		const provider = fakeProvider([leadReply, pingReply]);
		const auth = { apiKey: "sk-or-test", fetch: provider.fetch };
		let leadPayload: unknown;
		const leadReplyMessage = await stream(model, normalizeContext(leadContext(model)), {
			...auth,
			reasoning: "high",
			sessionId: "session-1",
			onPayload: (payload) => {
				leadPayload = structuredClone(payload);
				return payload;
			},
		}).result();
		expect(leadReplyMessage.stopReason).toBe("stop");

		const registry = { streamSimple: (pingModel: Model<Api>, context: Context, options?: SimpleStreamOptions) => stream(pingModel, normalizeContext(context), { ...options, ...auth }) };
		const ping = await new Promise<KeepalivePing>((resolve) => {
			const stop = keepWarm({ model, payload: leadPayload, sessionId: "session-1", sentAt: Date.now() - INTERVAL_MS }, INTERVAL_MS, registry, (result) => {
				stop();
				resolve(result);
			});
		});

		const [leadRequest, pingRequest] = provider.requests;
		expect(leadRequest!.body).toContain("export const board = [];");
		expect(pingRequest!.body).toBe(leadRequest!.body);
		expect(pingRequest!.headers.get("x-session-id")).toBe("session-1");
		expect(leadRequest!.headers.get("x-session-id")).toBe("session-1");
		expect(pingRequest!.chunksBeforeAbort).toBe(pingReply.chunks.length);
		expect(ping.error).toBeUndefined();
		if (pingUsage) expect(ping.usage).toMatchObject(pingUsage);
		else expect(ping.usage).toBeUndefined();
	});
});

const PING_USAGE = { ...NO_USAGE, input: 10, output: 1, cacheRead: 40_000, totalTokens: 40_011 };

/** A registry whose model either starts its reply at once or sends nothing until the request is aborted. */
function fakeRegistry(model: "replies" | "stays silent") {
	const sent: { payload: unknown; signal: AbortSignal }[] = [];
	const streamSimple = (requestModel: unknown, _context: unknown, options: { onPayload: (payload: unknown, model: unknown) => unknown; signal: AbortSignal }) => {
		const { signal } = options;
		sent.push({ payload: options.onPayload({ builtFrom: "an empty context" }, requestModel), signal });
		const aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "start" };
				if (model === "stays silent") await aborted;
				yield { type: signal.aborted ? "error" : "text_start" };
			},
			result: async () =>
				model === "replies" ? { stopReason: "aborted", usage: PING_USAGE } : { stopReason: "aborted", errorMessage: "Request was aborted", usage: NO_USAGE },
		};
	};
	return { sent, registry: { streamSimple } as never };
}

describe("keepalive timing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const request = (sentMsAgo: number) => ({ model: { id: "claude", provider: "anthropic" } as never, payload: { lead: true }, sessionId: "session-1", sentAt: Date.now() - sentMsAgo });

	it("pings one interval after the request was sent and after each ping, at once when overdue, until stopped", async () => {
		vi.useFakeTimers();
		const pings: KeepalivePing[] = [];
		const onTime = fakeRegistry("replies");
		const leadRequest = request(100_000);
		const stop = keepWarm(leadRequest, INTERVAL_MS, onTime.registry, (ping) => pings.push(ping));
		await vi.advanceTimersByTimeAsync(189_999);
		expect(onTime.sent).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(onTime.sent.map((ping) => ping.payload)).toEqual([{ lead: true }, { lead: true }]);
		expect(onTime.sent[0]!.payload).not.toBe(leadRequest.payload);
		expect(onTime.sent.every((ping) => ping.signal.aborted)).toBe(true);
		expect(pings).toEqual([
			{ sincePreviousMs: INTERVAL_MS, usage: PING_USAGE },
			{ sincePreviousMs: INTERVAL_MS, usage: PING_USAGE },
		]);
		stop();
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(onTime.sent).toHaveLength(2);

		const overdue = fakeRegistry("replies");
		const stopOverdue = keepWarm(request(400_000), INTERVAL_MS, overdue.registry, (ping) => pings.push(ping));
		await vi.advanceTimersByTimeAsync(0);
		expect(overdue.sent).toHaveLength(1);
		expect(pings[2]).toMatchObject({ sincePreviousMs: 400_000 });
		stopOverdue();
	});

	it("aborts a ping without a model event when the next one is due or on stop, and reports it as an error", async () => {
		vi.useFakeTimers();
		const pings: KeepalivePing[] = [];
		const { sent, registry } = fakeRegistry("stays silent");
		const stop = keepWarm(request(0), INTERVAL_MS, registry, (ping) => pings.push(ping));
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.signal.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(sent).toHaveLength(2);
		expect(sent[0]!.signal.aborted).toBe(true);
		expect(pings).toEqual([{ sincePreviousMs: INTERVAL_MS, error: "Request was aborted" }]);

		stop();
		await vi.advanceTimersByTimeAsync(0);
		expect(sent[1]!.signal.aborted).toBe(true);
		expect(pings).toHaveLength(2);
	});
});

/**
 * Standalone OpenRouter client (no pi). The key is read from OPENROUTER_API_KEY only and never logged.
 * Anthropic models get `cache_control: {type: "ephemeral"}` on the stable system prefix.
 */
import type { ChatMessage, CompleteFn, CompletionResult } from "./advisor.ts";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterOptions {
	model: string;
	maxTokens?: number;
	/** Prompt caching of messages marked `cache` (Anthropic only). Default true. */
	cache?: boolean;
	/** "1h" uses Anthropic's extended TTL. Default 5 min. */
	cacheTtl?: "5m" | "1h";
	/** Extra request fields (e.g. `reasoning: {effort: "low"}`). */
	extra?: Record<string, unknown>;
}

export function supportsCacheControl(model: string): boolean {
	return /^anthropic\//.test(model);
}

/** Pure: the JSON body sent to OpenRouter. */
export function buildOpenRouterRequest(messages: ChatMessage[], o: OpenRouterOptions): Record<string, unknown> {
	const cache = (o.cache ?? true) && supportsCacheControl(o.model);
	return {
		model: o.model,
		max_tokens: o.maxTokens ?? 8192,
		messages: messages.map((m) =>
			cache && m.cache
				? { role: m.role, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral", ...(o.cacheTtl === "1h" ? { ttl: "1h" } : {}) } }] }
				: { role: m.role, content: m.content },
		),
		usage: { include: true },
		...(o.extra ?? {}),
	};
}

/** Strip an "openrouter/" provider prefix: "openrouter/anthropic/x" → "anthropic/x". */
export function openRouterModelId(ref: string): string {
	return ref.replace(/^openrouter\//, "");
}

export function openRouterComplete(o: OpenRouterOptions, deps: { apiKey?: string; fetch?: typeof fetch; signal?: AbortSignal } = {}): CompleteFn {
	return async (messages): Promise<CompletionResult> => {
		const key = deps.apiKey ?? process.env.OPENROUTER_API_KEY;
		if (!key) return { text: "", stopReason: "error", errorMessage: "OPENROUTER_API_KEY is not set" };
		const f = deps.fetch ?? fetch;
		try {
			const res = await f(OPENROUTER_URL, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "baton" },
				body: JSON.stringify(buildOpenRouterRequest(messages, o)),
				signal: deps.signal,
			});
			if (!res.ok) return { text: "", stopReason: "error", errorMessage: `OpenRouter HTTP ${res.status}` };
			const j = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: unknown };
			const c = j.choices?.[0];
			return { text: c?.message?.content ?? "", stopReason: c?.finish_reason === "length" ? "length" : "stop", usage: j.usage };
		} catch (e) {
			return { text: "", stopReason: deps.signal?.aborted ? "aborted" : "error", errorMessage: (e as Error).message };
		}
	};
}

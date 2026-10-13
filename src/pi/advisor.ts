import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AdvisorResult, type ChatMessage, type CompleteFn, runAdvisor } from "../core/advisor.ts";
import { parseModelRef } from "./config.ts";

export type { AdvisorResult };

function text(content: readonly { type: string; text?: string }[]): string {
	return content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
}

/**
 * Pure: map Baton chat messages to a pi Context. The cacheable system message becomes pi's
 * systemPrompt; pi-ai marks it with Anthropic `cache_control` for openrouter/anthropic/* models
 * whenever cacheRetention is not "none".
 */
export function toPiContext(messages: ChatMessage[]): { systemPrompt?: string; messages: { role: "user" | "assistant"; content: any; timestamp: number }[] } {
	const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
	return {
		systemPrompt: sys || undefined,
		messages: messages
			.filter((m) => m.role !== "system")
			.map((m) => ({ role: m.role as "user" | "assistant", content: [{ type: "text", text: m.content }], timestamp: Date.now() })),
	};
}

/** Call the advisor through pi's model registry (credentials from pi's auth.json / env). */
export async function callAdvisor(
	ctx: ExtensionContext,
	modelRef: string,
	messages: ChatMessage[],
	opts: { maxTokens: number; cache: "short" | "long" | "none"; signal?: AbortSignal },
): Promise<AdvisorResult> {
	const ref = parseModelRef(modelRef);
	const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
	if (!model) return { ok: false, raw: "", errors: [`advisor model ${modelRef} not found in pi's model registry (check /model and baton.json)`], model: modelRef, attempts: 0, usages: [] };
	const sessionId = uuidv7();
	const complete: CompleteFn = async (msgs) => {
		const res = await ctx.modelRegistry.complete(model, toPiContext(msgs) as any, { maxTokens: opts.maxTokens, signal: opts.signal, cacheRetention: opts.cache, sessionId });
		return { text: text(res.content as any), stopReason: res.stopReason as any, errorMessage: res.errorMessage, usage: res.usage };
	};
	return runAdvisor(modelRef, messages, complete);
}

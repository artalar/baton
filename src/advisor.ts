import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseModelRef } from "./config.ts";
import { type AdvisorReply, parseAdvisorReply } from "./schema.ts";

export interface AdvisorResult {
	ok: boolean;
	reply?: AdvisorReply;
	truncated?: boolean;
	raw: string;
	errors?: string[];
	usage?: unknown;
	model: string;
	attempts: number;
}

function text(content: readonly { type: string; text?: string }[]): string {
	return content.flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
}

/**
 * Call the advisor once (plus a single retry when the JSON is invalid), with prompt caching
 * disabled. Credentials come from pi (auth.json / env) through the model registry.
 */
export async function callAdvisor(ctx: ExtensionContext, modelRef: string, pack: string, maxTokens: number, signal?: AbortSignal): Promise<AdvisorResult> {
	const ref = parseModelRef(modelRef);
	const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
	if (!model) return { ok: false, raw: "", errors: [`advisor model ${modelRef} not found in pi's model registry (check /model and baton.json)`], model: modelRef, attempts: 0 };

	const sessionId = uuidv7();
	const messages: { role: "user" | "assistant"; content: any; timestamp: number }[] = [{ role: "user", content: [{ type: "text", text: pack }], timestamp: Date.now() }];
	let raw = "";
	let usage: unknown;
	for (let attempt = 1; attempt <= 2; attempt++) {
		const res = await ctx.modelRegistry.complete(model, { messages: messages as any }, { maxTokens, signal, cacheRetention: "none", sessionId });
		usage = res.usage;
		if (res.stopReason === "error" || res.stopReason === "aborted")
			return { ok: false, raw, errors: [res.errorMessage ?? res.stopReason], usage, model: modelRef, attempts: attempt };
		raw = text(res.content as any);
		const parsed = parseAdvisorReply(raw);
		if (parsed.ok) return { ok: true, reply: parsed.reply, truncated: parsed.truncated, raw, usage, model: modelRef, attempts: attempt };
		if (attempt === 2) return { ok: false, raw, errors: parsed.errors, usage, model: modelRef, attempts: attempt };
		messages.push({ role: "assistant", content: res.content, timestamp: Date.now() } as any);
		const cut = res.stopReason === "length";
		messages.push({
			role: "user",
			content: [
				{
					type: "text",
					text: cut
						? "Your reply was cut off at the output token limit. Reply again with ONE valid JSON object only, much shorter: at most 5 steps, at most 40 words per field, no long quotes, in English."
						: `Your reply did not match the schema: ${parsed.errors.join("; ")}. Reply again with ONE valid JSON object only.`,
				},
			],
			timestamp: Date.now(),
		});
	}
	return { ok: false, raw, model: modelRef, attempts: 2 };
}

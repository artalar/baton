/**
 * Provider-agnostic advisor call: one completion plus a single retry when the JSON is invalid
 * or cut off. The transport is injected (`complete`), so pi's modelRegistry and the standalone
 * OpenRouter client share the same retry/validation logic.
 */
import { type AdvisorReply, parseAdvisorReply } from "./schema.ts";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
	cache?: boolean;
}

export interface CompletionResult {
	text: string;
	stopReason: "stop" | "length" | "error" | "aborted";
	errorMessage?: string;
	usage?: unknown;
}

export type CompleteFn = (messages: ChatMessage[]) => Promise<CompletionResult>;

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

export async function runAdvisor(model: string, messages: ChatMessage[], complete: CompleteFn): Promise<AdvisorResult> {
	const msgs = [...messages];
	let raw = "";
	let usage: unknown;
	for (let attempt = 1; attempt <= 2; attempt++) {
		const res = await complete(msgs);
		usage = res.usage;
		if (res.stopReason === "error" || res.stopReason === "aborted") return { ok: false, raw, errors: [res.errorMessage ?? res.stopReason], usage, model, attempts: attempt };
		raw = res.text;
		const parsed = parseAdvisorReply(raw);
		if (parsed.ok) return { ok: true, reply: parsed.reply, truncated: parsed.truncated, raw, usage, model, attempts: attempt };
		if (attempt === 2) return { ok: false, raw, errors: parsed.errors, usage, model, attempts: attempt };
		msgs.push({ role: "assistant", content: raw });
		msgs.push({
			role: "user",
			content:
				res.stopReason === "length"
					? "Your reply was cut off at the output token limit. Reply again with ONE valid JSON object only, much shorter: at most 5 steps, at most 40 words per field, no long quotes, in English."
					: `Your reply did not match the schema: ${parsed.errors.join("; ")}. Reply again with ONE valid JSON object only.`,
		});
	}
	return { ok: false, raw, model, attempts: 2 };
}

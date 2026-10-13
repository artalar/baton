/**
 * Standalone client for OpenRouter's decisions API (`/api/alpha/decisions`, e.g. typesafe/jev-1.13). No pi dependency.
 * The key is read from OPENROUTER_API_KEY only (or passed explicitly) and never logged or returned.
 * Every answer is validated against the question's declared type; a missing answer or a type mismatch is an error
 * (callers fall back to deterministic rules). Successful decisions are kept in a small LRU cache.
 */
export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

export type JevQuestion =
	| { type: "noul"; instructions: string }
	| { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevQuestions = Record<string, JevQuestion>;
export type JevAnswer = { type: "noul"; noul: number } | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number };
export type JevAnswers = Record<string, JevAnswer>;

export interface JevUsage {
	input_tokens?: number;
	output_tokens?: number;
	cost?: number;
}
export interface JevResult {
	ok: true;
	answers: JevAnswers;
	model: string;
	usage: JevUsage;
	latMs: number;
	cached: boolean;
	attempt: "primary" | "fallback";
}
export interface JevError {
	ok: false;
	error: string;
	latMs: number;
	/** Errors of every attempted model, in order. */
	errors: { model: string; error: string; latMs: number }[];
	/** Cost of attempts that returned a body but failed validation. */
	cost: number;
}

export interface JevOptions {
	model: string;
	fallbackModel?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}
export interface JevDeps {
	apiKey?: string;
	fetch?: typeof fetch;
	cache?: LruCache<JevResult>;
	now?: () => number;
}

/** Pure: validate one decisions response body against the questions. Returns the typed answers or why it is invalid. */
export function validateAnswers(body: unknown, questions: JevQuestions): { answers: JevAnswers } | { error: string } {
	if (!body || typeof body !== "object") return { error: "response is not an object" };
	const a = (body as { answers?: unknown }).answers;
	if (!a || typeof a !== "object") return { error: "response has no answers" };
	const out: JevAnswers = {};
	for (const [id, q] of Object.entries(questions)) {
		const x = (a as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
		if (!x || typeof x !== "object") return { error: `answer ${id} missing` };
		if (x.type !== q.type) return { error: `answer ${id}: type ${String(x.type)} ≠ ${q.type}` };
		if (q.type === "noul") {
			const v = x.noul;
			if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) return { error: `answer ${id}: noul not in [0,1]` };
			out[id] = { type: "noul", noul: v };
		} else {
			const p = x.probabilities as Record<string, unknown> | undefined;
			if (typeof x.choice !== "string" || !(x.choice in q.criteria)) return { error: `answer ${id}: choice ${String(x.choice)} not in criteria` };
			if (!p || typeof p !== "object") return { error: `answer ${id}: no probabilities` };
			const probs: Record<string, number> = {};
			for (const k of Object.keys(q.criteria)) {
				const v = p[k] ?? 0;
				if (typeof v !== "number" || !Number.isFinite(v)) return { error: `answer ${id}: probability ${k} not a number` };
				probs[k] = v;
			}
			out[id] = { type: "choice", choice: x.choice, probabilities: probs, confidence: typeof x.confidence === "number" ? x.confidence : undefined };
		}
	}
	return { answers: out };
}

/** Small LRU (Map insertion order). */
export class LruCache<V> {
	private m = new Map<string, V>();
	private max: number;
	constructor(max = 256) {
		this.max = max;
	}
	get(k: string): V | undefined {
		const v = this.m.get(k);
		if (v !== undefined) {
			this.m.delete(k);
			this.m.set(k, v);
		}
		return v;
	}
	set(k: string, v: V): void {
		this.m.delete(k);
		this.m.set(k, v);
		while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
	}
	get size() {
		return this.m.size;
	}
}

/** Stable cache key (FNV-1a over the canonical JSON). */
export function cacheKey(model: string, state: unknown, questions: JevQuestions): string {
	const s = JSON.stringify([model, state, questions]);
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `${h.toString(16)}:${s.length}`;
}

const defaultCache = new LruCache<JevResult>(256);

async function once(model: string, state: unknown, questions: JevQuestions, o: JevOptions, d: JevDeps, key: string): Promise<{ ok: true; r: JevResult } | { ok: false; error: string; latMs: number; cost: number }> {
	const now = d.now ?? Date.now;
	const t0 = now();
	const signals = [AbortSignal.timeout(o.timeoutMs), ...(o.signal ? [o.signal] : [])];
	try {
		const res = await (d.fetch ?? fetch)(DECISIONS_URL, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-title": "baton" },
			body: JSON.stringify({ model, state, questions }),
			signal: AbortSignal.any(signals),
		});
		if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, latMs: now() - t0, cost: 0 };
		const body = (await res.json()) as { model?: string; usage?: JevUsage };
		const v = validateAnswers(body, questions);
		const usage = body.usage ?? {};
		if ("error" in v) return { ok: false, error: `invalid: ${v.error}`, latMs: now() - t0, cost: usage.cost ?? 0 };
		return { ok: true, r: { ok: true, answers: v.answers, model: body.model ?? model, usage, latMs: now() - t0, cached: false, attempt: "primary" } };
	} catch (e) {
		const err = e as Error;
		const timeout = err.name === "TimeoutError" || (err.name === "AbortError" && !o.signal?.aborted);
		return { ok: false, error: timeout ? `timeout ${o.timeoutMs} ms` : `${err.name}: ${err.message}`.slice(0, 200), latMs: now() - t0, cost: 0 };
	}
}

/**
 * Ask the decisions API. Primary model first, then `fallbackModel` (same request, one field changed); each attempt
 * has its own `timeoutMs`. Never throws.
 */
export async function decide(state: unknown, questions: JevQuestions, o: JevOptions, d: JevDeps = {}): Promise<JevResult | JevError> {
	const key = d.apiKey ?? process.env.OPENROUTER_API_KEY;
	const cache = d.cache ?? defaultCache;
	const now = d.now ?? Date.now;
	const t0 = now();
	if (!key) return { ok: false, error: "OPENROUTER_API_KEY is not set", latMs: 0, errors: [], cost: 0 };
	const errors: JevError["errors"] = [];
	let cost = 0;
	const models = [o.model, ...(o.fallbackModel && o.fallbackModel !== o.model ? [o.fallbackModel] : [])];
	for (const [i, model] of models.entries()) {
		const ck = cacheKey(model, state, questions);
		const hit = cache.get(ck);
		if (hit) return { ...hit, cached: true, latMs: now() - t0, usage: { ...hit.usage, cost: 0 }, attempt: i ? "fallback" : "primary" };
		if (o.signal?.aborted) break;
		const r = await once(model, state, questions, o, d, key);
		if (r.ok) {
			const out: JevResult = { ...r.r, attempt: i ? "fallback" : "primary", latMs: now() - t0 };
			cache.set(ck, out);
			return out;
		}
		cost += r.cost;
		errors.push({ model, error: r.error, latMs: r.latMs });
	}
	return { ok: false, error: errors.map((e) => `${e.model}: ${e.error}`).join("; ") || "aborted", latMs: now() - t0, errors, cost };
}

/** Shorthand accessors (callers have validated answers). */
export const noul = (a: JevAnswers, id: string): number => (a[id]?.type === "noul" ? (a[id] as { noul: number }).noul : 0);
export const prob = (a: JevAnswers, id: string, choice: string): number => (a[id]?.type === "choice" ? ((a[id] as { probabilities: Record<string, number> }).probabilities[choice] ?? 0) : 0);
export const choiceOf = (a: JevAnswers, id: string): string | undefined => (a[id]?.type === "choice" ? (a[id] as { choice: string }).choice : undefined);

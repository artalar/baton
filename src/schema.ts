import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const VERDICTS = ["on_track", "course_correct", "replan", "done", "need_user"] as const;

export const AdvisorStep = Type.Object({
	id: Type.String({ minLength: 1 }),
	action: Type.String({ minLength: 1 }),
	files: Type.Optional(Type.Array(Type.String())),
	done_when: Type.String({ minLength: 1 }),
	avoid: Type.Optional(Type.String()),
	escalate_if: Type.Optional(Type.String()),
	/** "self": small/mechanical fix, the executor verifies it and marks it done, no re-review. Default "review". */
	verify: Type.Optional(Type.Union([Type.Literal("self"), Type.Literal("review")])),
});

export const AdvisorReply = Type.Object({
	assessment: Type.Optional(Type.String()),
	verdict: Type.Union(VERDICTS.map((v) => Type.Literal(v))),
	facts_corrected: Type.Array(
		Type.Object({ claim: Type.String(), truth: Type.String(), evt: Type.Optional(Type.Array(Type.Number())) }),
	),
	plan: Type.Array(AdvisorStep),
	do_not_retry: Type.Array(Type.String()),
	test_cmd: Type.Union([Type.String(), Type.Null()]),
	questions_for_user: Type.Optional(Type.Array(Type.String())),
	next_checkpoint: Type.Optional(Type.String()),
	invariants: Type.Optional(Type.Array(Type.String())),
	rules: Type.Optional(Type.Array(Type.String())),
	checkpoints: Type.Optional(Type.Array(Type.String())),
	deferred_rulings: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String({ minLength: 1 }),
				ruling: Type.Union([Type.Literal("unblock"), Type.Literal("drop"), Type.Literal("keep")]),
				guidance: Type.Optional(Type.String()),
			}),
		),
	),
});

export type AdvisorReply = Static<typeof AdvisorReply>;

export const MAX_STEPS = 7;

/** JSON schema text embedded in the advisor prompt. */
export const REPLY_SCHEMA_TEXT = `{
  "assessment": "1-3 sentences: where we are and what is wrong",
  "verdict": "on_track | course_correct | replan | done | need_user",
  "facts_corrected": [{"claim": "what the executor believes", "truth": "what is actually true", "evt": [12]}],
  "plan": [{"id": "S1", "action": "what to do", "files": ["src/a.ts"], "done_when": "checkable criterion (command/test)", "avoid": "what not to do", "escalate_if": "when to call the advisor again", "verify": "self | review"}],
  "do_not_retry": ["approach X - evt 40-52"],
  "test_cmd": "command that proves the work, or null",
  "questions_for_user": [],
  "next_checkpoint": "after S2 | on red tests | before commit",
  "invariants": ["architecture decisions / invariants the executor must keep"],
  "rules": ["concrete rule from a project skill the code must follow (name the skill)"],
  "checkpoints": ["S2", "S4"],
  "deferred_rulings": [{"id": "D1", "ruling": "unblock | drop | keep", "guidance": "how to resolve it, or why to drop it (only when DEFERRED ITEMS are listed)"}]
}`;

/** Pull the first balanced JSON object out of a model reply (tolerates ```json fences and prose). */
export function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidates = [fenced?.[1], text];
	for (const c of candidates) {
		if (!c) continue;
		const start = c.indexOf("{");
		if (start < 0) continue;
		let depth = 0;
		let inStr = false;
		let esc = false;
		for (let i = start; i < c.length; i++) {
			const ch = c[i];
			if (inStr) {
				if (esc) esc = false;
				else if (ch === "\\") esc = true;
				else if (ch === '"') inStr = false;
				continue;
			}
			if (ch === '"') inStr = true;
			else if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) {
				try {
					return JSON.parse(c.slice(start, i + 1));
				} catch {
					break;
				}
			}
		}
	}
	return undefined;
}

/**
 * Pure: salvage a JSON object cut off by max_tokens. Cuts back to the last complete value
 * (a "," or a closing bracket outside strings) and closes the open brackets. Returns undefined
 * when nothing usable is left.
 */
export function repairTruncatedJson(text: string): unknown {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	const stack: string[] = [];
	const cuts: { pos: number; stack: string[] }[] = [];
	let inStr = false;
	let esc = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
		else if (ch === "}" || ch === "]") {
			stack.pop();
			if (!stack.length) return undefined; // complete object: not a truncation case
			cuts.push({ pos: i + 1, stack: [...stack] });
		} else if (ch === ",") cuts.push({ pos: i, stack: [...stack] });
	}
	for (let k = cuts.length - 1; k >= 0; k--) {
		const c = cuts[k]!;
		try {
			return JSON.parse(text.slice(start, c.pos) + [...c.stack].reverse().join(""));
		} catch {
			/* try an earlier cut */
		}
	}
	return undefined;
}

export type ParseResult = { ok: true; reply: AdvisorReply; truncated: boolean; repaired?: boolean } | { ok: false; errors: string[] };

export function parseAdvisorReply(text: string): ParseResult {
	let json = extractJson(text);
	let repaired = false;
	if (json === undefined) {
		// cut off by max_tokens: salvage what is complete and default the missing tail fields
		const fixed = repairTruncatedJson(text) as Record<string, unknown> | undefined;
		if (fixed && typeof fixed === "object" && typeof fixed.verdict === "string" && Array.isArray(fixed.plan)) {
			json = { facts_corrected: [], do_not_retry: [], test_cmd: null, ...fixed, plan: (fixed.plan as unknown[]).filter((st) => Value.Check(AdvisorStep, st)) };
			repaired = true;
		}
	}
	if (json === undefined) return { ok: false, errors: ["no JSON object found in reply (cut off at max tokens?)"] };
	if (!Value.Check(AdvisorReply, json)) {
		const errors = [...Value.Errors(AdvisorReply, json)].slice(0, 8).map((e) => `${(e as { instancePath?: string }).instancePath ?? ""} ${e.message}`.trim());
		return { ok: false, errors };
	}
	const reply = json as AdvisorReply;
	const truncated = reply.plan.length > MAX_STEPS;
	if (truncated) reply.plan = reply.plan.slice(0, MAX_STEPS);
	return { ok: true, reply, truncated: truncated || repaired, repaired };
}

/** Human/LLM readable plan block appended to context or put into the reset summary. */
export function renderPlan(r: AdvisorReply, label: string, truncated = false): string {
	const out: string[] = [`<advisor_plan source="${label}" verdict="${r.verdict}">`];
	if (r.assessment) out.push(`Assessment: ${r.assessment}`);
	if (r.facts_corrected.length) {
		out.push("Corrected facts:");
		for (const f of r.facts_corrected) out.push(`- ${f.claim} → ${f.truth}${f.evt?.length ? ` (evt ${f.evt.join(",")})` : ""}`);
	}
	if (r.plan.length) {
		out.push("Steps:");
		for (const s of r.plan) {
			out.push(`- [${s.id}]${s.verify === "self" ? " (verify: self — no re-review)" : ""} ${s.action}${s.files?.length ? ` (files: ${s.files.join(", ")})` : ""}`);
			out.push(`  done when: ${s.done_when}`);
			if (s.avoid) out.push(`  avoid: ${s.avoid}`);
			if (s.escalate_if) out.push(`  escalate if: ${s.escalate_if}`);
		}
	}
	if (r.invariants?.length) {
		out.push("Invariants (keep them):");
		for (const x of r.invariants) out.push(`- ${x}`);
	}
	if (r.rules?.length) {
		out.push("Project skill rules (follow them):");
		for (const x of r.rules) out.push(`- ${x}`);
	}
	if (r.checkpoints?.length) out.push(`Review checkpoints: call baton_review after ${r.checkpoints.join(", ")}`);
	if (truncated) out.push(`(plan cut to ${MAX_STEPS} steps: call the advisor again after the last one)`);
	if (r.deferred_rulings?.length) {
		out.push("Deferred item rulings:");
		for (const d of r.deferred_rulings) out.push(`- ${d.id}: ${d.ruling}${d.guidance ? ` — ${d.guidance}` : ""}`);
	}
	if (r.do_not_retry.length) out.push(`Do not retry: ${r.do_not_retry.join("; ")}`);
	if (r.test_cmd) out.push(`Test command: ${r.test_cmd}`);
	if (r.questions_for_user?.length) out.push(`Questions for the user: ${r.questions_for_user.join(" | ")}`);
	if (r.next_checkpoint) out.push(`Next checkpoint: ${r.next_checkpoint}`);
	out.push("</advisor_plan>");
	return out.join("\n");
}

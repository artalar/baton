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
});

export type AdvisorReply = Static<typeof AdvisorReply>;

export const MAX_STEPS = 7;

/** JSON schema text embedded in the advisor prompt. */
export const REPLY_SCHEMA_TEXT = `{
  "assessment": "1-3 sentences: where we are and what is wrong",
  "verdict": "on_track | course_correct | replan | done | need_user",
  "facts_corrected": [{"claim": "what the executor believes", "truth": "what is actually true", "evt": [12]}],
  "plan": [{"id": "S1", "action": "what to do", "files": ["src/a.ts"], "done_when": "checkable criterion (command/test)", "avoid": "what not to do", "escalate_if": "when to call the advisor again"}],
  "do_not_retry": ["approach X - evt 40-52"],
  "test_cmd": "command that proves the work, or null",
  "questions_for_user": [],
  "next_checkpoint": "after S2 | on red tests | before commit"
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

export type ParseResult = { ok: true; reply: AdvisorReply; truncated: boolean } | { ok: false; errors: string[] };

export function parseAdvisorReply(text: string): ParseResult {
	const json = extractJson(text);
	if (json === undefined) return { ok: false, errors: ["no JSON object found in reply"] };
	if (!Value.Check(AdvisorReply, json)) {
		const errors = [...Value.Errors(AdvisorReply, json)].slice(0, 8).map((e) => `${(e as { instancePath?: string }).instancePath ?? ""} ${e.message}`.trim());
		return { ok: false, errors };
	}
	const reply = json as AdvisorReply;
	const truncated = reply.plan.length > MAX_STEPS;
	if (truncated) reply.plan = reply.plan.slice(0, MAX_STEPS);
	return { ok: true, reply, truncated };
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
			out.push(`- [${s.id}] ${s.action}${s.files?.length ? ` (files: ${s.files.join(", ")})` : ""}`);
			out.push(`  done when: ${s.done_when}`);
			if (s.avoid) out.push(`  avoid: ${s.avoid}`);
			if (s.escalate_if) out.push(`  escalate if: ${s.escalate_if}`);
		}
	}
	if (truncated) out.push(`(plan cut to ${MAX_STEPS} steps: call the advisor again after the last one)`);
	if (r.do_not_retry.length) out.push(`Do not retry: ${r.do_not_retry.join("; ")}`);
	if (r.test_cmd) out.push(`Test command: ${r.test_cmd}`);
	if (r.questions_for_user?.length) out.push(`Questions for the user: ${r.questions_for_user.join(" | ")}`);
	if (r.next_checkpoint) out.push(`Next checkpoint: ${r.next_checkpoint}`);
	out.push("</advisor_plan>");
	return out.join("\n");
}

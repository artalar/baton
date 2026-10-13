import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { renderPinned } from "../src/index.ts";
import { isReferenceRead, maskMessages, pinPlan } from "../src/mask.ts";
import { buildPack } from "../src/pack.ts";
import { excludePathspec, packExcludes } from "../src/repo.ts";
import { parseAdvisorReply } from "../src/schema.ts";
import { discoverSkills, selectSkills, type SkillDoc } from "../src/skills.ts";
import { callFacts, evaluate, initialTriggerState, onAdvisor, onToolResult, planGate } from "../src/triggers.ts";
import { charsForTokens, estimateTokens, globToRegExp, matchesAny } from "../src/util.ts";

const cfg = DEFAULT_CONFIG.triggers;

describe("token estimate", () => {
	it("is conservative: chars/2.4, non-ASCII counted twice", () => {
		expect(estimateTokens("a".repeat(240))).toBe(100);
		expect(estimateTokens("я".repeat(120))).toBe(100);
		expect(charsForTokens(100)).toBe(240);
	});
});

describe("globs", () => {
	it("matches ** / * / ? and anchors", () => {
		expect(globToRegExp("**/node_modules/**").test("node_modules/x/y.js")).toBe(true);
		expect(globToRegExp("**/node_modules/**").test("a/node_modules/x")).toBe(true);
		expect(matchesAny("package-lock.json", ["**/package-lock.json"])).toBe(true);
		expect(matchesAny("./.pi/baton/raw/1.txt", [".pi/baton/**"])).toBe(true);
		expect(matchesAny("src/dist.ts", ["**/dist/**"])).toBe(false);
		expect(matchesAny("/home/x/.agents/skills/r/SKILL.md", ["**/SKILL.md"])).toBe(true);
	});
});

describe("pack excludes", () => {
	it("always adds the journal dir and builds git exclude pathspecs", () => {
		const ex = packExcludes("./.baton-journal/", DEFAULT_CONFIG.pack.excludePaths);
		expect(ex).toContain(".baton-journal/**");
		expect(ex).toContain(".pi/baton/**");
		expect(ex).toContain("**/package-lock.json");
		expect(ex).toContain("**/node_modules/**");
		expect(ex).toContain("**/dist/**");
		const spec = excludePathspec(ex);
		expect(spec.slice(0, 2)).toEqual(["--", "."]);
		expect(spec).toContain(":(exclude,glob).pi/baton/**");
	});
});

describe("reference reads are never masked", () => {
	const globs = DEFAULT_CONFIG.mask.neverMaskPaths;
	it("detects read tool and simple bash reads of skills/docs", () => {
		expect(isReferenceRead("read", { path: ".agents/skills/reatom/SKILL.md" }, "/p", globs)).toBe(true);
		expect(isReferenceRead("read", { path: "/p/AGENTS.md" }, "/p", globs)).toBe(true);
		expect(isReferenceRead("read", { path: "src/a.ts" }, "/p", globs)).toBe(false);
		expect(isReferenceRead("bash", { command: "cat .agents/skills/reatom/SKILL.md .agents/skills/reatom-jsx/REFERENCE.md" }, "/p", globs)).toBe(true);
		expect(isReferenceRead("bash", { command: "cat .agents/skills/reatom/SKILL.md && rm -rf src" }, "/p", globs)).toBe(false);
		expect(isReferenceRead("bash", { command: "cat src/a.ts" }, "/p", globs)).toBe(false);
		expect(isReferenceRead("read", { path: ".agents/skills/x/SKILL.md" }, "/p", [])).toBe(false);
	});
	it("keeps answered skill reads visible in the request (configurable)", () => {
		const big = "rule ".repeat(500);
		const msgs = [
			{ role: "user", content: "task" },
			{ role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: { path: ".agents/skills/reatom/SKILL.md" } }, { type: "toolCall", id: "b", name: "read", arguments: { path: "src/a.ts" } }] },
			{ role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: big }] },
			{ role: "toolResult", toolCallId: "b", toolName: "read", content: [{ type: "text", text: big }] },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		];
		const base = { enabled: true, exemptTools: [], dedupReads: true, staleReads: true, cwd: "/p" };
		const on = maskMessages(msgs, () => undefined, { ...base, neverMaskPaths: DEFAULT_CONFIG.mask.neverMaskPaths }).messages;
		expect(JSON.stringify(on[2])).toContain("rule rule");
		expect(JSON.stringify(on[3])).toContain("baton: output masked");
		const off = maskMessages(msgs, () => undefined, { ...base, neverMaskPaths: [] }).messages;
		expect(JSON.stringify(off[2])).toContain("baton: output masked");
	});
});

describe("pinned plan", () => {
	it("is appended to the first user message only", () => {
		const out = pinPlan([{ role: "user", content: "task" }, { role: "assistant", content: [] }, { role: "user", content: [{ type: "text", text: "more" }] }], "PLAN");
		expect(JSON.stringify(out[0])).toContain("<baton_pinned_plan>\\nPLAN");
		expect(JSON.stringify(out[2])).not.toContain("PLAN");
		expect(pinPlan([{ role: "assistant", content: [] }], "PLAN")).toHaveLength(1);
	});
	it("renders progress marks, invariants, rules and checkpoints", () => {
		const r = parseAdvisorReply(
			JSON.stringify({ verdict: "on_track", facts_corrected: [], plan: [{ id: "S1", action: "model", done_when: "tests" }, { id: "S2", action: "ui", done_when: "smoke" }], do_not_retry: [], test_cmd: null, invariants: ["no setInterval"], rules: ["reatom-async: use wrap"], checkpoints: ["S1"] }),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const t = renderPinned({ reply: r.reply, label: "baton_plan" }, { S1: "done" });
		expect(t).toContain("[x] S1");
		expect(t).toContain("[ ] S2");
		expect(t).toContain("no setInterval");
		expect(t).toContain("reatom-async: use wrap");
		expect(t).toContain("call baton_review after S1");
	});
});

describe("skills selection", () => {
	const sk = (name: string, description: string, size: number): SkillDoc => ({ name, description, path: `.agents/skills/${name}/SKILL.md`, body: `# ${name}\n${"x".repeat(size)}` });
	const all = [sk("reatom", "Reatom core @reatom/core models", 3000), sk("reatom-jsx", "@reatom/jsx JSX components", 4000), sk("reatom-review", "Reviews Reatom code", 40_000), sk("python-lint", "flake8 rules", 2000)];
	it("picks relevant skills, prefers review skills for review, clips the biggest to fit", () => {
		const p = selectSkills(all, "review: import { atom } from '@reatom/core'; import { mount } from '@reatom/jsx'; Reatom JSX", 6000, { maxSkills: 4, prefer: /review/ });
		const names = p.skills.map((x) => x.name);
		expect(names).toContain("reatom");
		expect(names).toContain("reatom-jsx");
		expect(names).toContain("reatom-review");
		expect(names).not.toContain("python-lint");
		expect(p.tokens).toBeLessThanOrEqual(6000);
		expect(p.skills.find((x) => x.name === "reatom-review")?.clipped).toBe(true);
		expect(p.skills.find((x) => x.name === "reatom")?.clipped).toBe(false);
	});
	it("returns nothing when no skill is relevant", () => {
		expect(selectSkills(all, "fix the rust borrow checker error", 6000).skills).toHaveLength(0);
	});
	it("discovers SKILL.md with frontmatter", () => {
		const d = mkdtempSync(join(tmpdir(), "baton-sk-"));
		mkdirSync(join(d, ".agents/skills/reatom"), { recursive: true });
		writeFileSync(join(d, ".agents/skills/reatom/SKILL.md"), "---\nname: reatom\ndescription: Reatom core\n---\nbody");
		const s = discoverSkills(d);
		expect(s).toEqual([{ name: "reatom", description: "Reatom core", path: ".agents/skills/reatom/SKILL.md", body: expect.stringContaining("body") }]);
	});
});

describe("advisor pack framing", () => {
	it("review: third-person junior framing, no-tools notice, skills first, instructions last, claims unverified", () => {
		const p = buildPack(
			{ kind: "review", task: "T", userPrompts: [], question: "all done, tests pass", diff: "+x", previousPlan: "PLAN", skills: [{ name: "reatom", path: "p", body: "RULES" }] },
			40_000,
		);
		expect(p.text).toContain("junior executor");
		expect(p.text).toContain("You have NO tools");
		expect(p.text).toContain("do not ask for files");
		expect(p.text).toContain("EXECUTOR CLAIMS (unverified)\nall done, tests pass");
		expect(p.text).toContain("PINNED PLAN (review against it)");
		const iSkills = p.text.indexOf("PROJECT SKILLS");
		const iDiff = p.text.indexOf("## GIT DIFF");
		const iInstr = p.text.indexOf("## INSTRUCTIONS");
		expect(iSkills).toBeGreaterThan(0);
		expect(iSkills).toBeLessThan(iDiff);
		expect(iDiff).toBeLessThan(iInstr);
		expect(p.text.lastIndexOf('"verdict"')).toBeGreaterThan(iInstr);
	});
	it("plan: findings and invariants/rules/checkpoints requested", () => {
		const p = buildPack({ kind: "plan", task: "T", userPrompts: [], timeline: [{ evt: 3, ts: "", turn: 1, kind: "tool_call", tool: "read", argsDigest: "path=package.json", exit: 0 }] }, 40_000);
		expect(p.text).toContain("EXPLORATION FINDINGS");
		expect(p.text).toContain("invariants");
		expect(p.text).toContain("checkpoints");
	});
	it("stays within budget with non-ASCII content", () => {
		const p = buildPack({ kind: "review", task: "T", userPrompts: [], diff: "д".repeat(80_000), changedFiles: [{ path: "a", content: "ф".repeat(80_000) }] }, 10_000);
		expect(p.tokens).toBeLessThanOrEqual(10_300);
	});
});

describe("planning and milestone triggers", () => {
	it("nudges baton_plan after N exploration calls, once", () => {
		let s = initialTriggerState();
		for (let i = 0; i < cfg.autoPlanAfterReads; i++) s = onToolResult(s, "read", null, false, { readOnly: true });
		const r = evaluate(s, cfg, null);
		expect(r.nudge?.kind).toBe("auto_plan");
		expect(evaluate(onToolResult(r.state, "read", null, false, { readOnly: true }), cfg, null).nudge?.kind).not.toBe("auto_plan");
	});
	it("soft-gates the first write once when there is no plan", () => {
		const s = initialTriggerState();
		expect(planGate("write", s, cfg)?.block).toBe(true);
		expect(planGate("bash", s, cfg)).toBeUndefined();
		expect(planGate("write", { ...s, planGateFired: true }, cfg)).toBeUndefined();
		expect(planGate("edit", onAdvisor(s, "plan", "on_track", 3), cfg)).toBeUndefined();
		expect(planGate("write", s, { ...cfg, planBeforeWrite: false })).toBeUndefined();
	});
	it("nudges an early review at the first milestone after edits, again only after the next review cycle", () => {
		let s = onToolResult(initialTriggerState(), "write", null, true);
		s = onToolResult(s, "bash", null, false, { milestone: true });
		const r = evaluate(s, cfg, null);
		expect(r.nudge?.kind).toBe("milestone");
		let s2 = onToolResult(r.state, "bash", null, false, { milestone: true });
		expect(evaluate(s2, cfg, null).nudge?.kind).not.toBe("milestone");
		s2 = onAdvisor(s2, "review", "course_correct", 2);
		s2 = onToolResult(onToolResult(s2, "edit", null, true), "bash", null, false, { milestone: true });
		expect(evaluate(s2, cfg, null).nudge?.kind).toBe("milestone");
	});
	it("default reminder is earlier (12 calls)", () => {
		expect(cfg.remindEvery).toBe(12);
		let s = onAdvisor(initialTriggerState(), "plan", "on_track", 0);
		for (let i = 0; i < 12; i++) s = onToolResult(s, "bash", null, false);
		expect(evaluate(s, { ...cfg, driftCalls: 0 }, null).nudge?.kind).toBe("reminder");
	});
	it("detects drift: too many calls without baton_step while a plan is pinned", () => {
		let s = onAdvisor(initialTriggerState(), "plan", "on_track", 3);
		for (let i = 0; i < cfg.driftCalls; i++) s = onToolResult(s, "bash", null, false);
		// remindEvery would also fire; drift has priority
		expect(evaluate(s, cfg, null).nudge?.kind).toBe("drift");
		const s2 = onToolResult(s, "baton_step", null, false);
		expect(s2.lastStepAt).toBe(s2.toolCalls);
	});
	it("derives call facts", () => {
		expect(callFacts("read", undefined, 0, null).readOnly).toBe(true);
		expect(callFacts("bash", "ls -la && cat package.json", 0, null).readOnly).toBe(true);
		expect(callFacts("bash", "npm install", 0, null).readOnly).toBe(false);
		expect(callFacts("bash", "npx vitest run", 0, { passed: 5, failed: 0 }).milestone).toBe(true);
		expect(callFacts("bash", "npx vitest run", 1, { passed: 5, failed: 1 }).milestone).toBe(false);
		expect(callFacts("bash", "npm run build", 0, null).milestone).toBe(true);
		expect(callFacts("bash", "npm run build", 2, null).milestone).toBe(false);
	});
});

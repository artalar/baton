import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	anchorCache,
	budgetExceeded,
	type Call,
	countCacheControl,
	DEFAULT_SWITCH,
	decideTurn,
	executedSegments,
	gateCall,
	guardCheck,
	harnessReport,
	initialSwitchState,
	isVerify,
	LEAD_SYSTEM_NOTE,
	leadRequestPlan,
	MSG,
	optimizeContext,
	shapeContext,
	type TurnInput,
	verifyKinds,
} from "../src/pi/switch-core.ts";

// pre-0.10 thresholds (0.10 defaults are covered in test/switch-v010.test.ts)
const cfg = { ...DEFAULT_SWITCH, leadReadTurnsToDelegate: 2, minReadCalls: 0, minFollowupCalls: 0, maxFollowups: 2 };
const c = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ id, name, args });
let t = 0;
const turn = (p: Partial<TurnInput>): TurnInput => ({ turn: t++, now: 1000 + t, text: "", calls: [], results: [], empty: false, ...p });
const bash = (id: string, command: string) => c(id, "bash", { command });
const T18 = JSON.parse(readFileSync(new URL("./fixtures/t18-command.json", import.meta.url), "utf8")).command as string;

describe("1. verify detection on executed commands only", () => {
	it("arm D T18: heredoc'd files and node -e scripts mentioning tsc/vitest/vite build are not a verify run", () => {
		expect(T18).toContain("vitest/globals");
		expect(T18).toContain("tsc && vite build");
		expect(isVerify(bash("x", T18))).toBe(false);
		expect(executedSegments(T18).some((s) => /\btsc\b|vitest|vite build/.test(s))).toBe(false);
	});
	it("real runs are detected at command starts and after && ; | newlines, with runners/env/timeout", () => {
		expect(verifyKinds(bash("a", "cd /x && npx tsc --noEmit 2>&1 | tail -5"))).toEqual(["tsc"]);
		expect(verifyKinds(bash("a", "npm run build; npm test"))).toEqual(["build", "test"]);
		expect(verifyKinds(bash("a", "CI=1 timeout 60 npx vitest run"))).toEqual(["test"]);
		expect(verifyKinds(bash("a", "cat > f <<'EOF'\nnpm test\nEOF\nnpx vitest run src/a.test.ts"))).toEqual(["test"]);
		expect(isVerify(bash("a", "echo 'npm test' && grep tsc package.json"))).toBe(false);
		expect(isVerify(bash("a", "npx tsc --version"))).toBe(false);
		expect(isVerify(bash("a", "pnpm exec vitest"))).toBe(true);
	});
	it("heredoc writes no longer flip the lead into debug", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		const d = decideTurn(s, turn({ calls: [bash("h", T18)], results: [{ id: "h", isError: false, text: "" }] }), cfg);
		expect(d.to).toBe("lead");
	});
});

describe("2. tests are written by the lead; debug only after tests exist / ran", () => {
	it("lead verify (tsc) after writing without tests stays with the lead; with test files → debug", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		decideTurn(s, turn({ calls: [c("w", "write", { path: "src/a.ts" })] }), cfg);
		expect(decideTurn(s, turn({ calls: [bash("v", "npx tsc --noEmit")], results: [{ id: "v", isError: true, text: "TS2322" }] }), cfg).to).toBe("lead");
		expect(decideTurn(s, turn({ calls: [bash("v2", "npx tsc --noEmit")], results: [{ id: "v2", isError: true, text: "TS2322" }], testsExist: true }), cfg).to).toBe("debug");
	});
	it("lead running tests itself unlocks debug", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		decideTurn(s, turn({ calls: [c("w", "write", { path: "src/a.ts" })] }), cfg);
		expect(decideTurn(s, turn({ calls: [bash("v", "npx vitest run")], results: [{ id: "v", isError: true, text: "FAIL" }] }), cfg).to).toBe("debug");
	});
	it("lead finishing without any tests is nudged once to write tests", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		decideTurn(s, turn({ calls: [c("w", "write", { path: "src/a.ts" })] }), cfg);
		const d = decideTurn(s, turn({ text: "done" }), cfg);
		expect(d).toMatchObject({ to: "lead", continue: true });
		expect(d.message?.text).toBe(MSG.noTests);
		expect(decideTurn(s, turn({ text: "done" }), cfg).to).toBe("debug");
	});
	it("lead prompt asks for tests with the code and does not instruct baton tool use", () => {
		// 0.10 (user decision): the lead prompt prescribes the plan → helper-implements split, tests listed in the spec
		expect(MSG.lead("x", "")).toMatch(/tests to write/);
		expect(MSG.lead("x", "")).toMatch(/kind:"implement"/);
	});
});

describe("read-only classifier (arm E)", () => {
	it("version probes are reads", async () => {
		const { isReadOnly } = await import("../src/pi/switch-core.ts");
		expect(isReadOnly(bash("a", "cat /x/.gitignore /x/skills-lock.json; ls -R /x/.pi 2>/dev/null | head -30; cat /x/.pi/* 2>/dev/null | head -50; node --version; npm --version; ls /x/node_modules 2>/dev/null | head"))).toBe(true);
	});
});

describe("bash writes count as code writes", () => {
	it("heredoc / redirect / tee writes are edits; reads and /dev/null are not", async () => {
		const { bashWriteTargets } = await import("../src/pi/switch-core.ts");
		expect(bashWriteTargets(bash("a", T18))).toEqual(["src/tetris.ts", "src/main.tsx", "index.html", "vite.config.ts", "tsconfig.json", "(node -e script)"].filter((x) => x !== "(node -e script)"));
		expect(bashWriteTargets(bash("a", "npx tsc 2>&1 | tail; ls > /dev/null"))).toEqual([]);
		expect(bashWriteTargets(bash("a", "echo x | tee -a notes.md"))).toEqual(["notes.md"]);
		expect(bashWriteTargets(bash("a", "node -e 'require(\"fs\").writeFileSync(\"a\",\"b\")'"))).toEqual(["(node -e script)"]);
	});
	it("a lead bash-heredoc write consumes planning and counts as a lead edit", () => {
		const s = initialSwitchState(0);
		decideTurn(s, turn({ text: "READ DONE" }), cfg);
		decideTurn(s, turn({ calls: [bash("h", T18)] }), cfg);
		expect(s.planningLeft).toBe(0);
		expect(s.leadEditsInStretch).toBe(1);
		expect(decideTurn(s, turn({ calls: [bash("v", "npx vitest run")], results: [{ id: "v", isError: true, text: "FAIL" }] }), cfg).to).toBe("debug");
	});
});

describe("3/4. thinking cap via max_tokens; planning on the first writing turn", () => {
	it("planning stays pending through read-only lead turns and is consumed by the first edit", () => {
		const s = initialSwitchState(0);
		decideTurn(s, turn({ text: "READ DONE" }), cfg);
		expect(leadRequestPlan(s, cfg)).toMatchObject({ planning: true, capReasoning: false, maxTokens: cfg.leadMaxTokens });
		decideTurn(s, turn({ calls: [c("r", "read", { path: "a" })] }), cfg);
		expect(s.planningLeft).toBe(1);
		decideTurn(s, turn({ calls: [c("w", "write", { path: "a.ts" })] }), cfg);
		expect(s.planningLeft).toBe(0);
		// after a write the next turn may write again: reasoning capped, output not capped
		expect(leadRequestPlan(s, cfg)).toMatchObject({ planning: false, capReasoning: true, maxTokens: cfg.leadMaxTokens });
		decideTurn(s, turn({ calls: [c("r2", "read", { path: "b" })] }), cfg);
		expect(leadRequestPlan(s, cfg)).toMatchObject({ planning: false, capReasoning: true, maxTokens: cfg.nonWriteMaxTokens });
	});
	it("delegate_reads return re-arms planning", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		decideTurn(s, turn({ calls: [c("d", "delegate_reads", { instruction: "x" })] }), cfg);
		decideTurn(s, turn({ text: "READ DONE" }), cfg);
		expect(s.planningLeft).toBe(1);
	});
	it("a length stop is continued and the next request is uncapped", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		const d = decideTurn(s, turn({ text: "partial", lengthStop: true }), cfg);
		expect(d).toMatchObject({ to: "lead", continue: true });
		expect(leadRequestPlan(s, cfg).maxTokens).toBe(cfg.leadMaxTokens);
		expect(s.metrics.lengthStops).toBe(1);
	});
});

describe("5. cache anchor", () => {
	it("anchors on the last part of any type and never exceeds 4 breakpoints", () => {
		const cc = { type: "ephemeral" };
		const base = (n: number) => ({
			messages: [
				{ role: "system", content: [{ type: "text", text: "s", cache_control: n > 0 ? cc : undefined }] },
				{ role: "user", content: [{ type: "text", text: "t" }, { type: "image_url", image_url: { url: "x" } }] },
				{ role: "assistant", content: null },
				{ role: "tool", content: "a" },
				{ role: "user", content: "b" },
				{ role: "user", content: [{ type: "text", text: "last", cache_control: n > 1 ? cc : undefined }] },
			],
			tools: [{ type: "function", cache_control: n > 2 ? cc : undefined }],
		});
		const r = anchorCache(base(3), 2);
		expect(r).toMatchObject({ anchored: true, at: 1, partType: "image_url", before: 3, after: 4 });
		const full = base(3);
		(full.messages[3] as { content: unknown }).content = [{ type: "text", text: "a", cache_control: cc }];
		expect(countCacheControl(full)).toBe(4);
		expect(anchorCache(full, 2)).toMatchObject({ anchored: false, skipped: "already 4 breakpoints" });
	});
	it("skips thinking parts", () => {
		const r = anchorCache({ messages: [{ role: "system", content: "s" }, { role: "assistant", content: [{ type: "text", text: "x" }, { type: "thinking", thinking: "t" }] }, { role: "user", content: "a" }, { role: "user", content: "b" }] }, 2);
		expect(r).toMatchObject({ anchored: true, at: 1, partType: "text" });
	});
});

describe("6. helper guardrails", () => {
	it("forbidden steps are detected", () => {
		expect(guardCheck(bash("a", "npx vitest run --passWithNoTests"))).toMatch(/passWithNoTests/);
		expect(guardCheck(c("e", "edit", { path: "src/a.ts", edits: [{ oldText: "x", newText: "x as unknown as Y" }] }))).toMatch(/as unknown as/);
		expect(guardCheck(c("e", "edit", { path: "src/a.test.ts", edits: [{ oldText: "it('a', f)", newText: "it.skip('a', f)" }] }))).toMatch(/skips/);
		expect(guardCheck(c("e", "edit", { path: "src/a.test.ts", edits: [{ oldText: "it('a', f)\nit('b', g)", newText: "it('a', f)" }] }))).toMatch(/removes test/);
		expect(guardCheck(c("e", "edit", { path: "package.json", edits: [{ oldText: '"vite": "^7.1.0"', newText: '"vite": "^6.3.0"' }] }))).toMatch(/downgrades vite/);
		expect(guardCheck(c("e", "edit", { path: "package.json", edits: [{ oldText: '"vite": "^6.1.0"', newText: '"vite": "^7.0.0"' }] }))).toBeUndefined();
		expect(guardCheck(bash("a", "rm src/game/model.test.ts"))).toMatch(/deletes test/);
		expect(guardCheck(bash("a", "npm i vitest@1.6.0"))).toMatch(/versions/);
		expect(guardCheck(c("w", "write", { path: "src/b.test.ts", content: "it('a')" }), () => "it('a')\nit('b')")).toMatch(/removes test/);
		expect(guardCheck(c("e", "edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }))).toBeUndefined();
	});
	it("the gate blocks, flags, and escalates on the second hit; flags reach the lead report", () => {
		const s = initialSwitchState(0);
		s.phase = "debug";
		expect(gateCall(s, bash("g1", "npx vitest --passWithNoTests"), () => true)?.reason).toMatch(/guardrail/);
		expect(s.wantLead).toBeUndefined();
		gateCall(s, c("g2", "edit", { path: "a.ts", edits: [{ oldText: "a", newText: "a as unknown as B" }] }), () => true);
		expect(s.wantLead).toMatch(/twice/);
		s.blocked.push("g1", "g2");
		const d = decideTurn(s, turn({ calls: [c("g2", "edit")], diffStat: () => " a.ts | 2 +-" }), cfg);
		expect(d.to).toBe("lead");
		expect(d.message!.text).toMatch(/SUSPICIOUS EDITS[\s\S]*BLOCKED bash: uses --passWithNoTests/);
		expect(s.flags).toHaveLength(2);
	});
	it("green tsc + tests: exploratory scripts end debug and go straight to review", () => {
		const s = initialSwitchState(0);
		s.phase = "debug";
		decideTurn(s, turn({ calls: [bash("t", "npx tsc --noEmit && npx vitest run")], results: [{ id: "t", isError: false, text: "ok" }] }), cfg);
		const d = decideTurn(s, turn({ calls: [bash("f", "node -e 'for(let i=0;i<1e4;i++) fuzz()'")] }), cfg);
		expect(d.to).toBe("review");
	});
});

describe("7. honest handoff", () => {
	it("debug → lead report: diff, final checks, one-line intents, suspicious list; raw helper turns hidden from the lead", () => {
		const s = initialSwitchState(0);
		s.phase = "debug";
		decideTurn(s, turn({ text: "Fix the off-by-one in rotate", calls: [c("e1", "edit", { path: "src/rot.ts", edits: [{ oldText: "a", newText: "b\nc" }] })], results: [{ id: "e1", isError: false, text: "ok" }] }), cfg);
		decideTurn(s, turn({ calls: [bash("v", "npx vitest run")], results: [{ id: "v", isError: false, text: "Tests 12 passed" }] }), cfg);
		const d = decideTurn(s, turn({ text: "GREEN", diffStat: () => " src/rot.ts | 3 ++-" }), cfg);
		const txt = d.message!.text;
		expect(d.message!.audience).toBe("lead");
		// 0.10: edit stretches come back as a short interruption summary
		expect(txt).toMatch(/^\[Baton harness\] interruption summary — automation \(helper model\), not you/);
		expect(txt).toContain("src/rot.ts | 3 ++-");
		expect(txt).toContain("- test: PASS");
		expect(txt).toContain("- src/rot.ts: Fix the off-by-one in rotate [+1 lines]");
		expect(txt).not.toMatch(/SUSPICIOUS EDITS/);
		expect(d.report).toMatchObject({ edits: 1, flags: 0 });
		// lead view: Opus turns untouched (with signatures), helper turns + results dropped
		const lead = "anthropic/claude-opus-5.5";
		const opus = { role: "assistant", model: lead, content: [{ type: "thinking", thinking: "p", thinkingSignature: "sig" }, { type: "toolCall", id: "o1", name: "bash" }] };
		const msgs = [
			{ role: "user", content: "task" },
			opus,
			{ role: "toolResult", toolCallId: "o1", content: [{ type: "text", text: "ok" }] },
			{ role: "custom", customType: "baton-switch-helper", content: MSG.debug },
			{ role: "assistant", model: "z-ai/glm", content: [{ type: "text", text: "Fix" }, { type: "toolCall", id: "e1", name: "edit" }] },
			{ role: "toolResult", toolCallId: "e1", content: [{ type: "text", text: "ok" }] },
			{ role: "custom", customType: "baton-switch-lead", content: txt },
		];
		const out = shapeContext(msgs, s, true, lead);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "custom"]);
		expect(out[1]).toBe(opus);
	});
	it("read stretch report carries the read outputs, labelled as automation's", () => {
		const s = initialSwitchState(0);
		decideTurn(s, turn({ calls: [c("r", "read", { path: "src/a.ts" }), bash("l", "ls src")], results: [{ id: "r", isError: false, text: "export const a = 1" }, { id: "l", isError: false, text: "a.ts" }] }), cfg);
		const d = decideTurn(s, turn({ text: "READ DONE" }), cfg);
		expect(d.message!.text).toMatch(/Reading was intercepted and performed by automation \(helper model\), not by you/);
		expect(d.message!.text).toContain("--- src/a.ts ---\nexport const a = 1");
		expect(d.message!.text).toContain("--- $ ls src ---");
	});
	it("report size is capped", () => {
		const s = initialSwitchState(0);
		s.stretchOutputs = [{ label: "a", text: "x".repeat(100) }, { label: "b", text: "y".repeat(100) }];
		const r = harnessReport(s, "read", "w", { ...cfg, reportChars: 150 });
		expect(r).toContain("[omitted: report size cap");
	});
});

describe("8. harness tools, metrics", () => {
	it("system note describes the tools neutrally", () => {
		expect(LEAD_SYSTEM_NOTE).toMatch(/baton_delegate/);
		expect(LEAD_SYSTEM_NOTE).toMatch(/baton_optimize/);
		expect(LEAD_SYSTEM_NOTE).not.toMatch(/\b(should|must|always)\b/i);
	});
	it("counts self-initiated baton calls; baton_delegate debug hands over; helper may not call them", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		decideTurn(s, turn({ calls: [c("o", "baton_optimize")] }), cfg);
		const d = decideTurn(s, turn({ calls: [c("d", "baton_delegate", { kind: "debug", instruction: "focus on rotate" })] }), cfg);
		expect(d.to).toBe("debug");
		expect(d.message!.text).toContain("focus on rotate");
		expect(s.metrics.selfBaton).toBe(2);
		expect(s.metrics.selfBatonByTool).toEqual({ baton_optimize: 1, baton_delegate: 1 });
		expect(gateCall(s, c("x", "baton_optimize"), () => true)?.block).toBe(true);
	});
	it("counts lead re-verification of helper work until the lead's next edit", () => {
		const s = initialSwitchState(0);
		s.phase = "debug";
		decideTurn(s, turn({ calls: [c("e", "edit", { path: "src/rot.ts", edits: [{ oldText: "a", newText: "b" }] })] }), cfg);
		decideTurn(s, turn({ text: "GREEN" }), cfg);
		decideTurn(s, turn({ calls: [c("r", "read", { path: "src/rot.ts" }), bash("v", "npx vitest run")], results: [{ id: "v", isError: false, text: "ok" }] }), cfg);
		decideTurn(s, turn({ calls: [c("w", "edit", { path: "src/x.ts" })] }), cfg);
		decideTurn(s, turn({ calls: [bash("v2", "npx tsc")] , results: [{ id: "v2", isError: false, text: "" }], testsExist: false }), cfg);
		expect(s.metrics).toMatchObject({ reverifyRuns: 1, reverifyReads: 1 });
	});
	it("baton_optimize stubs superseded reads and clips the rest", () => {
		const s = initialSwitchState(0);
		s.reads = [["a", "x.ts"], ["b", "x.ts"], ["c", "y.ts"]];
		expect(optimizeContext(s, 100)).toEqual({ stubbed: 1, clipped: 2 });
		expect(Object.keys(s.stubs)).toEqual(["a"]);
	});
});

describe("9. budget stop", () => {
	it("lead exact + helper × 2.3 + one-turn reserve", () => {
		const rows = {
			"anthropic/claude-opus-5.5": { model: "anthropic/claude-opus-5.5", turns: 3, cost: 0.8, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			"z-ai/glm-5.3-flash": { model: "z-ai/glm-5.3-flash", turns: 40, cost: 0.1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const b = { budgetUsd: 1.5, helperCostFactor: 2.3, reserveUsd: 0.5 };
		expect(budgetExceeded(rows, "anthropic/claude-opus-5.5", b)).toEqual({ stop: true, estimate: expect.closeTo(1.03, 5) }); // 1.03 + 0.5 ≥ 1.5
		expect(budgetExceeded(rows, "anthropic/claude-opus-5.5", { ...b, budgetUsd: 1.6 }).stop).toBe(false);
		expect(budgetExceeded(rows, "anthropic/claude-opus-5.5", { ...b, budgetUsd: 0 }).stop).toBe(false);
	});
});

describe("0.9.1: skill files reach the lead verbatim, deduplicated", () => {
	const big = (tag: string) => `${tag}\n${"reatom skill line\n".repeat(3000)}END-${tag}`;
	it("skill reads are never clipped or omitted; dups dropped; other reads still clipped", () => {
		const s = initialSwitchState(0);
		s.stretchOutputs = [
			{ label: ".agents/skills/reatom/SKILL.md", text: big("S1") },
			{ label: "/abs/repo/.agents/skills/reatom/REFERENCE.md", text: big("R1") },
			{ label: "src/big.ts", text: "x".repeat(50_000) },
			{ label: "$ cat .agents/skills/reatom/SKILL.md", text: big("S1") },
			{ label: "/abs/repo/.agents/skills/reatom/SKILL.md", text: "partial" },
			{ label: "node_modules/@reatom/jsx/README.md", text: "y".repeat(30_000) },
		];
		const r = harnessReport(s, "read", "done", { ...cfg, clipChars: 20_000, reportChars: 30_000 });
		expect(r).toContain("END-S1");
		expect(r).toContain("END-R1");
		expect(r.split("(skill file, verbatim)").length - 1).toBe(2);
		expect(r).not.toContain("--- /abs/repo/.agents/skills/reatom/SKILL.md");
		expect(r).toMatch(/src\/big\.ts ---\n[\s\S]*chars clipped|src\/big\.ts ---\n\[omitted/);
		expect(r).toContain("node_modules/@reatom/jsx/README.md ---\n[omitted");
	});
	it("skillKey", async () => {
		const { skillKey } = await import("../src/pi/switch-core.ts");
		expect(skillKey("/w/x/.agents/skills/a/SKILL.md")).toBe(".agents/skills/a/SKILL.md");
		expect(skillKey("$ cat .agents/skills/a/REFERENCE.md")).toBe(".agents/skills/a/REFERENCE.md");
		expect(skillKey("$ cat a.md b.md")).toBeUndefined();
		expect(skillKey("src/model.ts")).toBeUndefined();
		expect(skillKey("node_modules/x/README.md")).toBeUndefined();
	});
});

describe("0.9.3: green mid-work verify keeps the lead; endgame keeps the lead", () => {
	const lead = () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		s.leadEditsInStretch = 1;
		s.leadRanTests = true;
		return s;
	};
	const v = bash("v", "npx vitest run");
	it("green verify after writing → lead continues; red → debug", () => {
		expect(decideTurn(lead(), turn({ calls: [v], results: [{ id: "v", isError: false, text: "Tests 27 passed" }] }), cfg).to).toBe("lead");
		const d = decideTurn(lead(), turn({ calls: [v], results: [{ id: "v", isError: true, text: "FAIL x" }] }), cfg);
		expect(d.to).toBe("debug");
		expect(d.reason).toMatch(/failed/);
	});
	it("endgame (budget left < endgameUsd): no hand-off to the helper, even on red", () => {
		expect(decideTurn(lead(), turn({ calls: [v], results: [{ id: "v", isError: true, text: "FAIL x" }], budgetLeft: 0.2 }), cfg).to).toBe("lead");
		const s = lead();
		s.leadReadTurns = 1;
		expect(decideTurn(s, turn({ calls: [c("r", "read", { path: "a" })], budgetLeft: 0.1 }), cfg).to).toBe("lead");
		expect(decideTurn(lead(), turn({ calls: [v], results: [{ id: "v", isError: true, text: "FAIL x" }], budgetLeft: 0.5 }), cfg).to).toBe("debug");
	});
});

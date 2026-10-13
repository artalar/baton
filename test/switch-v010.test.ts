import { describe, expect, it } from "vitest";
import { type Call, DEFAULT_SWITCH, decideTurn, gateCall, harnessReport, initialSwitchState, MSG, type TurnInput } from "../src/pi/switch-core.ts";

const cfg = DEFAULT_SWITCH;
const c = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ id, name, args });
let t = 0;
const turn = (p: Partial<TurnInput>): TurnInput => ({ turn: t++, now: 1000 + t, text: "", calls: [], results: [], empty: false, ...p });

describe("0.10 reading: GLM reads enough and the lead's reads go to GLM", () => {
	it("read prompt names the skills, verbatim hand-off, min calls; READ DONE after 3 calls gets one 'read more' nudge", () => {
		expect(MSG.read).toMatch(/EVERY SKILL\.md and REFERENCE\.md/);
		expect(MSG.read).toMatch(/verbatim/);
		const s = initialSwitchState(0);
		decideTurn(s, turn({ calls: [c("a", "read", { path: "x" }), c("b", "read", { path: "y" }), c("c", "ls")], results: [] }), cfg);
		const d = decideTurn(s, turn({ text: "READ DONE" }), cfg);
		expect(d.to).toBe("read");
		expect(d.continue).toBe(true);
		expect(d.message?.text).toMatch(/only 3 tool call/);
		// second READ DONE → hand over
		expect(decideTurn(s, turn({ text: "READ DONE" }), cfg).to).toBe("lead");
	});
	it("enough calls → no nudge", () => {
		const s = initialSwitchState(0);
		decideTurn(s, turn({ calls: Array.from({ length: 6 }, (_, i) => c(`r${i}`, "read", { path: `f${i}` })) }), cfg);
		expect(decideTurn(s, turn({ text: "READ DONE" }), cfg).to).toBe("lead");
	});
	it("one read-only lead turn (arm H: Opus grepped node_modules) → helper follow-up with the lead's calls, up to 4 rounds", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		const d = decideTurn(s, turn({ calls: [c("g", "bash", { command: "grep -n export node_modules/@reatom/core/dist/index.d.ts" })] }), cfg);
		expect(d.to).toBe("followup");
		expect(d.message?.text).toContain("grep -n export node_modules/@reatom/core");
		expect(d.message?.text).toMatch(/skills\/REFERENCE\.md first/);
		expect(cfg.maxFollowups).toBe(4);
	});
});

describe("0.10 implement: GLM writes the files of the lead's spec", () => {
	const lead = () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		return s;
	};
	const spec = "Create src/ui/App.tsx exporting App(): JSX.Element using game model …; write src/ui/App.test.tsx";
	it("baton_delegate implement → implement phase with the spec; new files allowed, guardrails still apply", () => {
		const s = lead();
		const d = decideTurn(s, turn({ calls: [c("i", "baton_delegate", { kind: "implement", instruction: spec })] }), cfg);
		expect(d.to).toBe("implement");
		expect(d.message?.audience).toBe("helper");
		expect(d.message?.text).toContain(spec);
		expect(gateCall(s, c("w", "write", { path: "src/ui/App.tsx", content: "x" }), () => false)).toBeUndefined();
		expect(gateCall(s, c("w2", "write", { path: "src/a.ts", content: "const x = y as unknown as Z" }), () => false)?.block).toBe(true);
		expect(gateCall(s, c("b", "bash", { command: "npx vitest run --passWithNoTests" }), () => true)?.block).toBe(true);
	});
	it("implement done → Baton auto-check: red → helper debug with the failure; green → lead with the full diff", () => {
		const mk = () => {
			const s = lead();
			decideTurn(s, turn({ calls: [c("i", "baton_delegate", { kind: "implement", instruction: spec })] }), cfg);
			decideTurn(s, turn({ calls: [c("w", "write", { path: "src/ui/App.tsx", content: "x" })] }), cfg);
			return s;
		};
		const red = decideTurn(mk(), turn({ text: "IMPLEMENTED", autoCheck: () => ({ ok: false, text: "src/ui/App.tsx(3,1): error TS2304" }) }), cfg);
		expect(red.to).toBe("debug");
		expect(red.message?.text).toContain("error TS2304");
		const green = decideTurn(mk(), turn({ text: "IMPLEMENTED", autoCheck: () => ({ ok: true, text: "PASS" }), diffStat: () => " src/ui/App.tsx | 1 +", diffFull: () => "+++ b/src/ui/App.tsx\n+x" }), cfg);
		expect(green.to).toBe("lead");
		expect(green.message?.text).toMatch(/\[Baton harness\] interruption summary/);
		expect(green.message?.text).toMatch(/implemented your spec/);
		expect(green.message?.text).toMatch(/auto-check green/);
		expect(green.message?.text).not.toContain("+x");
	});
	it("ESCALATE in implement → lead; debug still forbids new files", () => {
		const s = lead();
		decideTurn(s, turn({ calls: [c("i", "baton_delegate", { kind: "implement", instruction: spec })] }), cfg);
		expect(decideTurn(s, turn({ text: "ESCALATE spec unclear" }), cfg).to).toBe("lead");
		const d = initialSwitchState(0);
		d.phase = "debug";
		expect(gateCall(d, c("w", "write", { path: "src/new.ts", content: "x" }), () => false)?.block).toBe(true);
	});
	it("Jev P(allow_handoff) does not end an implement stretch; weakens/tampers still do", async () => {
		const { applyJevGate } = await import("../src/pi/switch-core.ts");
		const s = initialSwitchState(0);
		s.phase = "implement";
		expect(applyJevGate(s, c("w", "write", { path: "a.ts" }), { action: "allow_handoff", reason: "jev: P(allow_handoff) 0.91" })).toBeUndefined();
		expect(s.wantLead).toBeUndefined();
		expect(applyJevGate(s, c("w", "write", { path: "a.ts" }), { action: "block", reason: "jev: weakens_checks 0.9" })?.block).toBe(true);
	});
	it("0.10.2: implement stretch has no time limit by default; explicit maxImplementMs still caps it", () => {
		expect(cfg.maxImplementMs).toBe(0);
		const s = initialSwitchState(0);
		s.phase = "implement";
		const late = (): TurnInput => ({ ...turn({ calls: [c("e", "edit", { path: "a.ts" })] }), now: 3_600_000 });
		expect(decideTurn(s, late(), cfg).to).toBe("implement");
		expect(decideTurn(s, late(), { ...cfg, maxImplementMs: 60_000 }).to).toBe("lead");
	});
	it("lead prompt prescribes the split", () => {
		expect(MSG.lead("x", "")).toMatch(/baton_delegate\(\{kind:"implement"/);
	});
	it("interruption summary: files + definitions + checks, no raw diff/edit calls", () => {
		const diff = [
			"diff --git a/src/ui/App.tsx b/src/ui/App.tsx",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/src/ui/App.tsx",
			"@@ -0,0 +1,3 @@",
			"+export function App() {",
			"+  return <div/>",
			"+}",
			"diff --git a/src/model.ts b/src/model.ts",
			"--- a/src/model.ts",
			"+++ b/src/model.ts",
			"@@ -10,2 +10,2 @@ export const reatomGame = (name: string) => {",
			"-  const speed = atom(1)",
			"+  const speed = atom(2)",
		].join("\n");
		const s = initialSwitchState(0);
		s.stretchEdits = [{ path: "src/ui/App.tsx", intent: "App" }, { path: "src/model.ts", intent: "speed" }];
		s.stretchChecks = { tsc: { cmd: "(baton auto-check) typecheck + tests", ok: true, tail: "PASS" } };
		s.lastVerifyGreen = true;
		const r = harnessReport(s, "implement", "done", cfg, " 2 files changed", diff);
		expect(r).toMatch(/^\[Baton harness\] interruption summary/);
		expect(r).toContain("- src/ui/App.tsx (new, +3/−0): App");
		expect(r).toMatch(/- src\/model\.ts \(modified, \+1\/−1\): .*reatomGame/);
		expect(r).toMatch(/- src\/model\.ts .*speed/);
		expect(r).toContain("auto-check (typecheck + tests): PASS");
		expect(r).not.toContain("return <div/>");
	});
	it("reserve default lowered to $0.25 (largest single lead turn seen: $0.197)", () => {
		expect(cfg.reserveUsd).toBe(0.25);
	});
});

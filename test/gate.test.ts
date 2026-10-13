import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { commitAllowedByGate, finalizeAllowedBash, finalizeGate, gateOnAdvisor, gateReleaseFinalize, type GateState, helpGate, initialGateState, reviewGate } from "../src/gate.ts";
import { numstatLines } from "../src/repo.ts";
import { parseAdvisorReply, renderPlan } from "../src/schema.ts";

const cfg = DEFAULT_CONFIG.review;
const afterReview = (steps: { id: string; verify?: "self" | "review" }[], verdict = "course_correct", calls = 100) => gateOnAdvisor(initialGateState(), "review", verdict, steps, calls, "abc", cfg);

describe("review gate", () => {
	it("allows the first review and one after a plan/help", () => {
		expect(reviewGate(initialGateState(), cfg, { calls: 3, status: {} }).allow).toBe(true);
		const g = gateOnAdvisor(afterReview([{ id: "A" }]), "help", "course_correct", [{ id: "H1" }], 101, undefined, cfg);
		expect(reviewGate(g, cfg, { calls: 102, status: {} }).allow).toBe(true);
	});
	it("refuses while review steps are open, allows when all are closed", () => {
		const g = afterReview([{ id: "A" }, { id: "B" }, { id: "C", verify: "self" }]);
		const r = reviewGate(g, cfg, { calls: 105, status: { A: "done" }, diffLines: 10 });
		expect(r.allow).toBe(false);
		expect(!r.allow && r.reason).toMatch(/B/);
		expect(reviewGate(g, cfg, { calls: 105, status: { A: "done", B: "deferred" } }).allow).toBe(true);
	});
	it("asks for the diff size before refusing, and accumulated change permits a review", () => {
		const g = afterReview([{ id: "A" }]);
		expect(reviewGate(g, cfg, { calls: 105, status: {} })).toMatchObject({ allow: false, needDiff: true });
		expect(reviewGate(g, cfg, { calls: 105, status: {}, diffLines: 80 }).allow).toBe(true);
		expect(reviewGate(g, cfg, { calls: 115, status: {} }).allow).toBe(true);
	});
	it("self-only steps neither require nor permit a review; closing them permits commit", () => {
		const g = afterReview([{ id: "A", verify: "self" }]);
		const r = reviewGate(g, cfg, { calls: 103, status: { A: "done" }, diffLines: 5 });
		expect(r.allow).toBe(false);
		expect(!r.allow && r.reason).toMatch(/commit/);
		expect(commitAllowedByGate(g, {})).toBe(false);
		expect(commitAllowedByGate(g, { A: "done" })).toBe(true);
		expect(commitAllowedByGate(afterReview([{ id: "A" }]), { A: "done" })).toBe(false);
	});
	it("disabled gate allows everything", () => {
		const g = afterReview([{ id: "A" }]);
		expect(reviewGate(g, { ...cfg, enabled: false }, { calls: 101, status: {} }).allow).toBe(true);
	});
});

describe("help rate limit", () => {
	it("refuses baton_help right after an advisor reply", () => {
		const g = afterReview([{ id: "A" }], "course_correct", 50);
		expect(helpGate(g, cfg, 52).allow).toBe(false);
		expect(helpGate(g, cfg, 55).allow).toBe(true);
		expect(helpGate(initialGateState(), cfg, 1).allow).toBe(true);
	});
});

describe("finalize mode", () => {
	const done = afterReview([{ id: "N1" }], "done");
	it("enters on done, refuses reviews, allows commit", () => {
		expect(done.finalize).toBe(true);
		expect(reviewGate(done, cfg, { calls: 500, status: { N1: "done" }, diffLines: 999 }).allow).toBe(false);
		expect(commitAllowedByGate(done, {})).toBe(true);
	});
	it("blocks the first edit or non-verification bash once", () => {
		expect(finalizeGate("edit", undefined, done)).toBeDefined();
		expect(finalizeGate("bash", "sed -i s/a/b/ x.ts", done)).toBeDefined();
		expect(finalizeGate("bash", "set -o pipefail; npx tsc --noEmit && npx vitest run && npx vite build", done)).toBeUndefined();
		expect(finalizeGate("bash", "git add -A && git commit -m done", done)).toBeUndefined();
		expect(finalizeGate("read", undefined, done)).toBeUndefined();
		expect(finalizeGate("edit", undefined, { ...done, finalizeWarned: true })).toBeUndefined();
		expect(finalizeGate("edit", undefined, afterReview([], "on_track"))).toBeUndefined();
	});
	it("ends on commit / user prompt", () => {
		const g = gateReleaseFinalize(done);
		expect(g.finalize).toBe(false);
		expect(reviewGate(g, cfg, { calls: 101, status: { N1: "done" } }).allow).toBe(true);
	});
	it("classifies finalize bash", () => {
		expect(finalizeAllowedBash("npm test")).toBe(true);
		expect(finalizeAllowedBash("git -c user.name=a commit -am x")).toBe(true);
		expect(finalizeAllowedBash("cat > a.ts <<EOF")).toBe(false);
	});
});

describe("schema verify field", () => {
	it("accepts verify self/review and renders it", () => {
		const raw = JSON.stringify({ verdict: "course_correct", facts_corrected: [], plan: [{ id: "S1", action: "rename x", done_when: "tsc ok", verify: "self" }, { id: "S2", action: "y", done_when: "z" }], do_not_retry: [], test_cmd: null });
		const p = parseAdvisorReply(raw);
		expect(p.ok).toBe(true);
		if (p.ok) expect(renderPlan(p.reply, "r")).toMatch(/\[S1\] \(verify: self/);
		expect(parseAdvisorReply(raw.replace('"self"', '"maybe"')).ok).toBe(false);
	});
	it("numstat sums", () => {
		expect(numstatLines("3\t4\ta.ts\n-\t-\tbin.png\n10\t0\tb.ts\n")).toBe(17);
	});
});

type Ev = { t: "call"; tool: string; commit: boolean } | { t: "step"; id: string; status: string } | { t: "advisor"; kind: "review" | "help" | "plan"; verdict: string; steps: { id: string }[] };

describe("C4 replay (review ping-pong)", () => {
	it("refuses self-invoked reviews #5, #6 and #8 (handoff numbering, #1 = plan)", () => {
		const evs = JSON.parse(readFileSync(new URL("./fixtures/c4-reviews.json", import.meta.url), "utf8")) as Ev[];
		let g: GateState = initialGateState();
		let status: Record<string, string> = {};
		let calls = 0;
		let n = 0;
		const verdicts: Record<number, boolean> = {};
		for (const e of evs) {
			if (e.t === "call") calls++;
			else if (e.t === "step") status[e.id] = e.status;
			else {
				n++;
				// diff size unknown in the journal: the small fixes of #5/#6/#8 were a few lines (< 80)
				if (e.kind === "review") verdicts[n] = reviewGate(g, cfg, { calls, status, diffLines: 0 }).allow;
				g = gateOnAdvisor(g, e.kind, e.verdict, e.steps, calls, "t", cfg);
				if (e.steps.length && e.verdict !== "done") status = {};
			}
		}
		expect(n).toBe(8);
		expect(verdicts).toEqual({ 2: true, 3: true, 4: true, 5: false, 6: false, 7: true, 8: false });
	});
});

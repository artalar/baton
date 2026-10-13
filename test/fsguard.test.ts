import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyEffects, diffSnaps, parseStatusV2, revertTo, snapshot } from "../src/pi/fsguard.ts";
import { type Call, DEFAULT_SWITCH, decideTurn, executedSegments, gateCall, harnessReport, initialSwitchState, leadRequestPlan, shapeContext, type TurnInput } from "../src/pi/switch-core.ts";

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
function repo() {
	const d = mkdtempSync(join(tmpdir(), "baton-fsg-"));
	g(d, "init", "-q");
	writeFileSync(join(d, "a.ts"), "export const a = 1\n");
	writeFileSync(join(d, "package.json"), '{"name":"x"}\n');
	writeFileSync(join(d, ".gitignore"), "node_modules\n");
	g(d, "add", "-A");
	g(d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
	return d;
}

describe("fs guard", () => {
	it("parses porcelain v2", () => {
		const r = parseStatusV2("# branch.oid abc\0# branch.head main\x001 .M N... 100644 100644 100644 h1 h2 src/a b.ts\0? new.ts\x002 R. N... 100644 100644 100644 h1 h2 R100 to.ts\0from.ts\0");
		expect(r.head).toBe("abc");
		expect(r.entries).toEqual([["src/a b.ts", ".M"], ["new.ts", "??"], ["to.ts", "R."]]);
	});
	it("no change → empty diff; detects modify / new / delete / HEAD / node_modules", () => {
		const d = repo();
		const s0 = snapshot(d);
		expect(diffSnaps(s0, snapshot(d))).toEqual({ changed: [], headChanged: false, nodeModulesChanged: false });
		writeFileSync(join(d, "a.ts"), "export const a = 2\n");
		mkdirSync(join(d, "src"));
		writeFileSync(join(d, "src/new.ts"), "x");
		mkdirSync(join(d, "node_modules"));
		expect(diffSnaps(s0, snapshot(d))).toEqual({ changed: ["a.ts", "src/new.ts"], headChanged: false, nodeModulesChanged: true });
	});
	it("reverts a read-phase change exactly: clean file from index, dirty file from saved contents, new files removed, backup kept", () => {
		const d = repo();
		writeFileSync(join(d, "a.ts"), "export const a = 'lead work'\n"); // dirty before (lead's own work)
		writeFileSync(join(d, "b.ts"), "untracked lead file\n");
		const pre = snapshot(d, { contents: true });
		writeFileSync(join(d, "a.ts"), "helper scribble\n");
		writeFileSync(join(d, "b.ts"), "helper scribble\n");
		writeFileSync(join(d, ".gitignore"), "changed\n");
		mkdirSync(join(d, "tmp/deep"), { recursive: true });
		writeFileSync(join(d, "tmp/deep/x.js"), "x");
		const diff = diffSnaps(pre, snapshot(d));
		const cls = classifyEffects(diff, executedSegments("node scratch.js"));
		expect(cls.revert.sort()).toEqual([".gitignore", "a.ts", "b.ts", "tmp/deep/x.js"]);
		const r = revertTo(d, pre, cls.revert, join(d, "..", `${d.split("/").pop()}-backup`));
		expect(readFileSync(join(d, "a.ts"), "utf8")).toBe("export const a = 'lead work'\n");
		expect(readFileSync(join(d, "b.ts"), "utf8")).toBe("untracked lead file\n");
		expect(readFileSync(join(d, ".gitignore"), "utf8")).toBe("node_modules\n");
		expect(existsSync(join(d, "tmp"))).toBe(false);
		expect(r.failed).toEqual([]);
		expect(readFileSync(join(r.backupDir!, "files/a.ts"), "utf8")).toBe("helper scribble\n");
		expect(diffSnaps(pre, snapshot(d)).changed).toEqual([]);
	});
	it("npm install: lockfile/package.json/node_modules kept, recorded as install; git commit is non-idempotent", () => {
		const diff = { changed: ["package-lock.json", "package.json"], headChanged: false, nodeModulesChanged: true };
		expect(classifyEffects(diff, executedSegments("npm i vitest"))).toEqual({ install: true, nonIdempotent: [], revert: [], keep: ["package-lock.json", "package.json", "node_modules/"] });
		const c2 = classifyEffects({ changed: [], headChanged: true, nodeModulesChanged: false }, executedSegments("git commit -qm x"));
		expect(c2.nonIdempotent).toEqual(["git HEAD moved", "ran: git commit -qm x"]);
		expect(classifyEffects({ changed: [], headChanged: false, nodeModulesChanged: false }, executedSegments("rm -rf /tmp/x")).nonIdempotent.length).toBe(1);
	});
	it("overhead is small (snapshot pair on a small repo)", () => {
		const d = repo();
		for (let i = 0; i < 30; i++) writeFileSync(join(d, `u${i}.ts`), "x");
		const ms: number[] = [];
		for (let i = 0; i < 10; i++) ms.push(snapshot(d, { contents: true }).ms + snapshot(d).ms);
		ms.sort((a, b) => a - b);
		expect(ms[5]!).toBeLessThan(200);
	});
});

const cfg = { ...DEFAULT_SWITCH };
const c = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ id, name, args });
let t = 0;
const turn = (p: Partial<TurnInput>): TurnInput => ({ turn: t++, now: 1000 + t, text: "", calls: [], results: [], empty: false, ...p });

describe("switch 0.8.1 wiring", () => {
	it("reading: any tool passes the gate (baton tools still lead-only)", () => {
		const s = initialSwitchState(0);
		expect(gateCall(s, c("1", "bash", { command: "npm --version && node -e 'console.log(1)'" }), () => true)).toBeUndefined();
		expect(gateCall(s, c("2", "write", { path: "x.ts" }), () => false)).toBeUndefined();
		expect(gateCall(s, c("3", "baton_optimize"), () => true)?.block).toBe(true);
	});
	it("a reverted call is dropped from both views and its guard note reaches the lead report", () => {
		const s = initialSwitchState(0);
		s.dropped.push("w");
		s.stretchGuard.push("the helper's write call changed files during reading; reverted and removed from history: x.ts (backup: /j/fsguard/1)");
		s.wantLead = "helper changed the working tree during reading (fs guard)";
		const d = decideTurn(s, turn({ calls: [c("r", "read", { path: "a.ts" }), c("w", "write", { path: "x.ts" })], results: [{ id: "r", isError: false, text: "A" }, { id: "w", isError: false, text: "ok" }] }), cfg);
		expect(d.to).toBe("lead");
		expect(d.message!.text).toContain("--- a.ts ---\nA");
		expect(d.message!.text).not.toContain("--- x.ts");
		expect(d.message!.text).toMatch(/File-system guard during this stretch:\n- the helper's write call changed files during reading; reverted/);
		const msgs = [
			{ role: "assistant", model: "glm", content: [{ type: "toolCall", id: "r", name: "read" }, { type: "toolCall", id: "w", name: "write" }] },
			{ role: "toolResult", toolCallId: "r", content: [{ type: "text", text: "A" }] },
			{ role: "toolResult", toolCallId: "w", content: [{ type: "text", text: "ok" }] },
		];
		const helperView = shapeContext(msgs, s, false, "opus");
		expect(helperView).toHaveLength(2);
		expect(helperView[0]!.content).toEqual([{ type: "toolCall", id: "r", name: "read" }]);
	});
	it("debug report carries guard notes too", () => {
		const s = initialSwitchState(0);
		s.stretchGuard.push("package install recorded, NOT reverted: `npm i x`");
		expect(harnessReport(s, "debug", "w", cfg)).toContain("package install recorded, NOT reverted");
	});
	it("lead: bash the guard saw change nothing counts as read-like; two such turns → helper reads", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		s.noChange.push("b1", "b2");
		expect(decideTurn(s, turn({ calls: [c("b1", "bash", { command: "node -e 'console.log(require(\"@reatom/core\"))'" })] }), cfg).to).toBe("lead");
		expect(decideTurn(s, turn({ calls: [c("b2", "bash", { command: "npx some-inspect" })] }), cfg).to).toBe("followup");
	});
	it("lead: a bash that changed files or a write breaks the read streak", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		decideTurn(s, turn({ calls: [c("r", "read", { path: "a" })] }), cfg);
		decideTurn(s, turn({ calls: [c("x", "bash", { command: "npm i foo" })] }), cfg); // not in noChange
		expect(s.leadReadTurns).toBe(0);
		expect(decideTurn(s, turn({ calls: [c("r2", "read", { path: "b" })] }), cfg).to).toBe("lead");
	});
	it("thinking cap on read-only lead turns while planning is pending; the first turn after handoff plans", () => {
		const s = initialSwitchState(0);
		decideTurn(s, turn({ text: "READ DONE" }), cfg);
		expect(leadRequestPlan(s, cfg).planning).toBe(true);
		decideTurn(s, turn({ calls: [c("r", "read", { path: "a" })] }), cfg);
		expect(s.planningLeft).toBe(1);
		expect(leadRequestPlan(s, cfg)).toMatchObject({ planning: false, capReasoning: true });
	});
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, deepMerge } from "../src/pi/config.ts";
import { pinnedBlock } from "../src/pi/index.ts";
import {
	bashReads,
	cutLoops,
	type DeferredItem,
	deferFire,
	deferredEditGate,
	failingTests,
	initialLoopState,
	type LoopFire,
	loopKeys,
	observeLoop,
	renderDeferred,
	resolveDeferred,
} from "../src/pi/loop.ts";
import { parseAdvisorReply } from "../src/core/schema.ts";

const cfg = DEFAULT_CONFIG.loop;
const CWD = "/workspace/tetris-exp/C";

interface Call {
	i: number;
	id: string;
	tool: string;
	input: Record<string, unknown>;
	output: string;
}
const c2: Call[] = JSON.parse(readFileSync(new URL("./fixtures/c2-calls.json", import.meta.url), "utf8"));

function replay(calls: Call[], c = cfg) {
	let s = initialLoopState();
	const fires: (LoopFire & { i: number })[] = [];
	for (const x of calls) {
		const r = observeLoop(s, x.id, loopKeys({ toolCallId: x.id, tool: x.tool, input: x.input, output: x.output }, CWD, c.ignoreReadPaths), c);
		s = r.state;
		if (r.fire) fires.push({ ...r.fire, i: x.i });
	}
	return fires;
}

describe("loop config", () => {
	it("has calibrated defaults and merges overrides", () => {
		expect(cfg).toMatchObject({ enabled: true, windowCalls: 30, maxHops: 6, hopGapCalls: 30, readRepeatThreshold: 8, action: "help", blockDeferredEdits: true });
		const m = deepMerge(DEFAULT_CONFIG, { loop: { maxHops: 4 } });
		expect(m.loop.maxHops).toBe(4);
		expect(m.loop.windowCalls).toBe(30);
	});
	it("baton.example.json documents the loop defaults", () => {
		const ex = JSON.parse(readFileSync(new URL("../baton.example.json", import.meta.url), "utf8"));
		expect(ex.loop).toEqual(cfg);
	});
});

describe("loop keys", () => {
	it("extracts failing test names from vitest output", () => {
		expect(failingTests(" FAIL  src/model/loop.test.ts > tetrisLoop > lock delay locks a grounded piece 150ms\n × other 3ms")).toEqual([
			{ name: "lock delay locks a grounded piece", file: "src/model/loop.test.ts" },
			{ name: "other" },
		]);
	});
	it("reads paths from bash read commands, ignoring quoted programs", () => {
		expect(bashReads("cd /w/C && awk 'NR>=1 && NR<=118' src/model/tetris.ts", "/w/C")).toEqual(["src/model/tetris.ts"]);
		expect(bashReads("sed -n '1,20p' a.ts | head -3", "/w")).toEqual(["a.ts"]);
		expect(bashReads("npm test", "/w")).toEqual([]);
	});
	it("ignores reference-doc reads", () => {
		const k = loopKeys({ toolCallId: "x", tool: "bash", input: { command: "sed -n '1,9p' .agents/skills/r/REFERENCE.md" }, output: "" }, "/w", cfg.ignoreReadPaths);
		expect(k.reads).toEqual([]);
	});
});

describe("loop detector on the C2 transcript", () => {
	const fires = replay(c2);
	it("fires on the lock-delay test loop after ≥6 edit→run→fail hops (call 324), not before", () => {
		expect(fires[0]).toMatchObject({ kind: "test", i: 324, target: 'test "lock delay locks a grounded piece"' });
		expect(fires[0]!.hops).toBeGreaterThanOrEqual(6);
		const loopStart = c2.find((x) => x.output.includes("lock delay locks"))!.i;
		expect(loopStart).toBe(303);
		expect(fires[0]!.i - loopStart).toBeLessThanOrEqual(25);
		expect(fires[0]!.span.length).toBe(22);
	});
	it("has no false positive in the normal work before the loop", () => {
		expect(fires.filter((f) => f.i < 303)).toEqual([]);
	});
	it("also catches the later re-read loop of tetris.ts", () => {
		const rd = fires.find((f) => f.kind === "read");
		expect(rd?.i).toBe(370);
		expect(rd?.target).toContain("src/model/tetris.ts");
	});
	it("can be disabled", () => {
		expect(replay(c2, { ...cfg, enabled: false })).toEqual([]);
	});
});

describe("synthetic fixture (C2 pattern)", () => {
	const fail = (i: number): Call => ({ i, id: `t${i}`, tool: "bash", input: { command: "npx vitest run src/model 2>&1 | tail" }, output: " FAIL  src/model/loop.test.ts > loop > lock delay\nAssertionError: expected 0 to be 1" });
	const edit = (i: number): Call => ({ i, id: `e${i}`, tool: "edit", input: { path: `${CWD}/src/model/loop.test.ts` }, output: "ok" });
	it("fires on the 6th edit→run→fail hop on the same test", () => {
		const calls: Call[] = [];
		for (let i = 0; i < 7; i++) calls.push(edit(2 * i), fail(2 * i + 1));
		const f = replay(calls);
		expect(f).toHaveLength(1);
		expect(f[0]).toMatchObject({ i: 13, count: 13, hops: 6, files: ["src/model/loop.test.ts"], sig: "AssertionError: expected 0 to be 1" });
	});
	it("does not count re-runs without edits as hops", () => {
		const calls: Call[] = [];
		for (let i = 0; i < 20; i++) calls.push(fail(i));
		expect(replay(calls)).toEqual([]);
	});
	it("does not count a changed failure as the same hop chain", () => {
		const calls: Call[] = [];
		for (let i = 0; i < 8; i++) calls.push(edit(2 * i), { ...fail(2 * i + 1), output: ` FAIL  a.test.ts > t${i}` });
		expect(replay(calls)).toEqual([]);
	});
	it("breaks the hop chain when failures are more than hopGapCalls apart", () => {
		const calls: Call[] = [];
		for (let i = 0; i < 10; i++) {
			calls.push(edit(i * 40 - 1), fail(i * 40));
			for (let j = 1; j < 39; j++) calls.push({ i: i * 40 + j, id: `r${i}-${j}`, tool: "bash", input: { command: "ls" }, output: "" });
		}
		expect(replay(calls)).toEqual([]);
	});
	it("attributes grep-filtered failures to the test named in the command", () => {
		const calls: Call[] = [fail(1)];
		for (let i = 2; i < 8; i++) calls.push(edit(100 + i), { i, id: `g${i}`, tool: "bash", input: { command: 'npx vitest run 2>&1 | grep -A5 "lock delay"' }, output: "AssertionError: expected 1 to be 0" });
		expect(replay(calls)[0]).toMatchObject({ i: 7, hops: 6 });
	});
	it("re-reads reset by a write", () => {
		const rd = (i: number): Call => ({ i, id: `r${i}`, tool: "read", input: { path: "src/a.ts" }, output: "x" });
		const w: Call = { i: 100, id: "w", tool: "edit", input: { path: "src/a.ts" }, output: "" };
		expect(replay([1, 2, 3, 4, 5, 6, 7].map(rd).concat([w], [8, 9, 10].map(rd)))).toEqual([]);
		expect(replay([1, 2, 3, 4, 5, 6, 7, 8].map(rd))[0]?.kind).toBe("read");
	});
});

describe("deferred items", () => {
	const fire: LoopFire = { kind: "test", key: "fail:x", target: 'test "x"', count: 3, span: ["a", "b", "c"], files: ["t.test.ts"], sig: "E", at: 3 };
	it("merges repeats of the same key and renders", () => {
		let { list } = deferFire([], fire);
		({ list } = deferFire(list, { ...fire, span: ["c", "d"], count: 2 }));
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ id: "D1", count: 5, cut: ["a", "b", "c", "d"] });
		expect(renderDeferred(list)).toContain("D1 DEFERRED");
		expect(pinnedBlock(undefined, {}, list)).toContain("Deferred items");
	});
	it("gates edits of deferred files until unblocked", () => {
		const { list } = deferFire([], fire);
		expect(deferredEditGate("edit", "t.test.ts", list, cfg)?.block).toBe(true);
		expect(deferredEditGate("read", "t.test.ts", list, cfg)).toBeUndefined();
		expect(deferredEditGate("edit", "t.test.ts", list, { ...cfg, blockDeferredEdits: false })).toBeUndefined();
		const un = resolveDeferred(list, [{ id: "D1", ruling: "unblock", guidance: "fake timers" }], "reviewer");
		expect(un[0]).toMatchObject({ status: "unblocked", by: "reviewer", guidance: "fake timers" });
		expect(deferredEditGate("edit", "t.test.ts", un, cfg)).toBeUndefined();
		expect(resolveDeferred(list, [{ id: "all", ruling: "drop" }], "user")[0]!.status).toBe("dropped");
		expect(resolveDeferred(list, [{ id: "D1", ruling: "keep" }], "user")[0]!.status).toBe("deferred");
	});
	it("reviewer schema accepts deferred_rulings", () => {
		const r = parseAdvisorReply(JSON.stringify({ verdict: "on_track", facts_corrected: [], plan: [], do_not_retry: [], test_cmd: null, deferred_rulings: [{ id: "D1", ruling: "unblock", guidance: "g" }] }));
		expect(r.ok).toBe(true);
		expect(r.ok && r.reply.deferred_rulings?.[0]?.ruling).toBe("unblock");
	});
});

describe("cutLoops", () => {
	const tc = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: {} });
	const res = (id: string, text = "long output") => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }] });
	it("removes looping calls/results and leaves one note in the first slot", () => {
		const msgs = [
			{ role: "user", content: "task" },
			{ role: "assistant", content: [tc("a")] },
			res("a"),
			{ role: "assistant", content: [{ type: "text", text: "try again" }, tc("b")] },
			res("b"),
			{ role: "assistant", content: [tc("c")] },
			res("c"),
			{ role: "assistant", content: [tc("z")] },
			res("z"),
		];
		const item: DeferredItem = { id: "D1", key: "fail:x", target: 'test "x"', count: 3, sig: "E", files: [], cut: ["a", "b", "c"], status: "deferred" };
		const { messages, cut } = cutLoops(msgs, [item]);
		expect(cut).toBe(2);
		const ids = messages.flatMap((m) => (m.role === "toolResult" ? [(m as { toolCallId?: string }).toolCallId] : []));
		expect(ids).toEqual(["a", "z"]);
		const note = (messages[2]!.content as { text: string }[])[0]!.text;
		expect(note).toMatch(/⚠ Loop detected \(D1\): 3 calls on test "x", error E\. .*DEFERRED/);
		// assistant with text keeps the text, loses the call; tool-only assistant for "c" is dropped
		expect(messages).toHaveLength(6);
		expect(messages[3]!.content).toEqual([{ type: "text", text: "try again" }]);
		// every remaining toolCall has its result
		const calls = messages.flatMap((m) => (m.role === "assistant" && Array.isArray(m.content) ? (m.content as { type: string; id?: string }[]).filter((c) => c.type === "toolCall").map((c) => c.id) : []));
		expect(calls).toEqual(ids);
	});
	it("is a no-op without items", () => {
		expect(cutLoops([{ role: "user", content: "x" }], []).cut).toBe(0);
	});
});

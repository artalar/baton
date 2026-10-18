import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HELPER_INSTRUCTION_TYPE, LEAD_NOTE_TYPE } from "../src/context.ts";
import baton from "../src/index.ts";

const LEAD = "anthropic/claude-opus-5.5";
const HELPER = "z-ai/glm-5.3-flash";
const agentDir = mkdtempSync(join(tmpdir(), "baton-agent-"));
const savedEnv = { ...process.env };

beforeAll(() => {
	process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterAll(() => {
	process.env = savedEnv;
});

function project() {
	const cwd = mkdtempSync(join(tmpdir(), "baton-project-"));
	mkdirSync(join(cwd, "src"));
	writeFileSync(join(cwd, "src/model.ts"), "export const model = 1;\n");
	return cwd;
}

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> };
type Call = { name: string; args: Record<string, unknown>; output?: string; isError?: boolean };
type ModelRef = { id: string; provider: string };
type StreamOptions = { onPayload: (payload: unknown, model: ModelRef) => unknown; sessionId?: string; signal: AbortSignal };
type Ping = { model: ModelRef; payload: unknown; sessionId?: string; signal: AbortSignal };

const PING_USAGE = { input: 12, output: 2, cacheRead: 40_000, cacheWrite: 0, totalTokens: 40_014, cost: { total: 0.008 } };

function mount(cwd: string) {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, Tool>();
	const pings: Ping[] = [];
	const thinking = { level: "medium", history: [] as string[] };
	const ctx = {
		cwd,
		hasUI: true,
		ui: { notify() {} },
		model: undefined as ModelRef | undefined,
		sessionManager: { getSessionId: () => "session-1" },
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			/** A provider whose model starts its reply at once and reports usage, as Anthropic does in message_start. */
			streamSimple(model: ModelRef, _context: unknown, options: StreamOptions) {
				pings.push({ model, payload: options.onPayload({ builtFrom: "an empty context" }, model), sessionId: options.sessionId, signal: options.signal });
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "start" };
						yield { type: "thinking_start" };
						yield { type: "thinking_delta" };
					},
					result: async () => ({ stopReason: options.signal.aborted ? "aborted" : "stop", usage: PING_USAGE }),
				};
			},
		},
	};
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => {};
		},
		registerTool(tool: Tool & { name: string }) {
			tools.set(tool.name, tool);
		},
		/** Like pi, a model switch resets the thinking level to the settings default. */
		async setModel(model: { id: string; provider: string }) {
			ctx.model = model;
			thinking.level = "high";
			return true;
		},
		getThinkingLevel: () => thinking.level,
		setThinkingLevel(level: string) {
			thinking.level = level;
			thinking.history.push(level);
		},
	};
	baton(pi as never);
	const emit = async (event: string, payload: unknown): Promise<any> => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
		return result;
	};
	let callCounter = 0;
	let requestCounter = 0;
	/**
	 * Simulates one assistant turn: the provider request, tool_call hooks, the side effect, then turn_end.
	 * `toolsMs` advances the fake clock between the request and turn_end, as long tool calls do.
	 */
	const turn = async (
		model: string,
		calls: (Call & { effect?: () => void })[],
		options: { text?: string; stopReason?: string; errorMessage?: string; usage?: Record<string, number>; toolsMs?: number } = {},
	) => {
		await emit("before_provider_request", { payload: { model, request: ++requestCounter } });
		const withIds = calls.map((call) => ({ ...call, id: `call-${++callCounter}` }));
		const blocked: string[] = [];
		for (const call of withIds) {
			const verdict = await emit("tool_call", { toolCallId: call.id, toolName: call.name, input: call.args });
			if (verdict?.block) blocked.push(verdict.reason);
			else call.effect?.();
		}
		if (options.toolsMs) await vi.advanceTimersByTimeAsync(options.toolsMs);
		const result = await emit("turn_end", {
			message: {
				role: "assistant",
				model,
				stopReason: options.stopReason ?? (withIds.length ? "toolUse" : "stop"),
				errorMessage: options.errorMessage,
				usage: options.usage,
				content: [...(options.text ? [{ type: "text", text: options.text }] : []), ...withIds.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.args }))],
			},
			toolResults: withIds.filter((call) => call.output !== undefined).map((call) => ({ toolCallId: call.id, isError: !!call.isError, content: [{ type: "text", text: call.output }] })),
		});
		return Object.assign(result ?? {}, { blocked, isEmpty: result === undefined });
	};
	const undo = (params: Record<string, unknown>) => tools.get("baton_undo")!.execute("t", params).then((reply) => reply.content[0]!.text);
	return { ctx, emit, turn, undo, pings, thinking };
}

async function startTask(h: ReturnType<typeof mount>, prompt = "Build tetris") {
	await h.emit("session_start", { reason: "startup" });
	return h.emit("before_agent_start", { messageType: "user", prompt, systemPrompt: "BASE PROMPT", systemPromptOptions: {} });
}

const write = (cwd: string, path: string, content: string) => () => writeFileSync(join(cwd, path), content);

describe("speculative runs in a pi session", () => {
	it("hands over after a lead turn, reports facts only, and lets the lead undo", async () => {
		const cwd = project();
		const h = mount(cwd);
		const start = await startTask(h);
		expect(start.systemPrompt).toMatch(/^BASE PROMPT\n\n# Baton: speculative runs[\s\S]*only files you have changed with edit\/write in this session, plus scratch files under \.pi\/baton\/scratch\/[\s\S]*baton_undo[\s\S]*The harness runs no checks for you/);
		expect(h.ctx.model?.id).toBe(LEAD);

		const handoff = await h.turn(LEAD, [{ name: "edit", args: { path: "src/model.ts", edits: [] }, output: "Edited" }]);
		expect(handoff.entries).toHaveLength(1);
		expect(handoff.entries[0]).toMatchObject({ customType: HELPER_INSTRUCTION_TYPE });
		expect(handoff.entries[0].content).toMatch(/Speculative run #1\. You are now the helper model/);
		expect(handoff.entries[0].content).toContain("You may change only the files the lead has written (src/model.ts) and files under .pi/baton/scratch/;");
		expect(handoff.continue).toBeUndefined();
		expect(h.ctx.model?.id).toBe(HELPER);
		expect(h.thinking.level).toBe("low");

		const scratchTest = ".pi/baton/scratch/model.test.ts";
		const first = await h.turn(
			HELPER,
			[
				{ name: "read", args: { path: "src/model.ts" }, output: "MODEL SOURCE" },
				{ name: "edit", args: { path: "src/model.ts", edits: [] }, output: "Edited", effect: write(cwd, "src/model.ts", "export const model = 2;\n") },
				{ name: "write", args: { path: scratchTest, content: "test" }, output: "Wrote", effect: write(cwd, scratchTest, "test('x')\n") },
				{ name: "bash", args: { command: "npm test" }, isError: true, output: "FAIL model.test.ts\nTests: 1 failed" },
			],
			{ text: "Updating the model." },
		);
		expect(first.isEmpty).toBe(true);
		expect(first.blocked).toEqual([]);
		const leadMessageWithThinking = {
			role: "assistant",
			model: LEAD,
			content: [
				{ type: "thinking", thinking: "Lead plan in thinking", thinkingSignature: "sig-lead" },
				{ type: "toolCall", id: "l" },
			],
			timestamp: 1,
		};
		const helperView = await h.emit("context", {
			messages: [leadMessageWithThinking],
		});
		expect(helperView.messages[0].content).toEqual([
			{ type: "text", text: "Lead plan in thinking" },
			{ type: "toolCall", id: "l" },
		]);

		const back = await h.turn(HELPER, [], { text: "All checks are green, the model is done." });
		expect(back.continue).toBe(true);
		expect(h.ctx.model?.id).toBe(LEAD);
		expect(h.thinking).toEqual({ level: "medium", history: ["medium", "low", "medium"] });
		const note: string = back.entries[0].content;
		expect(back.entries[0].customType).toBe(LEAD_NOTE_TYPE);
		expect(note).toMatch(/Speculative run #1 by the helper model \(glm-5\.3-flash\), not by you/);
		expect(note).toMatch(/It stopped because the helper ended its turn without tool calls: 2 turn\(s\), 4 tool call\(s\)/);
		expect(note).toContain("- modified src/model.ts (+1 −1)");
		expect(note).toContain(`- created ${scratchTest} (+1 −0)`);
		expect(note).toContain("+export const model = 2;");
		expect(note).toMatch(/bash `npm test` → error\n {3}FAIL model\.test\.ts/);
		expect(note).toMatch(/--- read src\/model\.ts ---\nMODEL SOURCE/);
		expect(note).not.toMatch(/All checks are green|Updating the model/);

		const leadView = await h.emit("context", {
			messages: [
				helperView.messages[0],
				{ role: "custom", customType: HELPER_INSTRUCTION_TYPE, content: "instruction", timestamp: 2 },
				{ role: "assistant", model: HELPER, content: [{ type: "toolCall", id: "h" }], timestamp: 3 },
				{ role: "toolResult", toolCallId: "h", content: [], timestamp: 4 },
				{ role: "custom", customType: LEAD_NOTE_TYPE, content: note, timestamp: 5 },
			],
		});
		expect(leadView.messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "custom"]);
		expect(leadView.messages[0].content).toEqual([
			{ type: "thinking", thinking: "Lead plan in thinking", thinkingSignature: "sig-lead" },
			{ type: "toolCall", id: "l" },
		]);

		expect(await h.undo({ run: 1, paths: [scratchTest] })).toBe(`baton_undo run #1: deleted ${scratchTest} (created by the run).`);
		expect(existsSync(join(cwd, scratchTest))).toBe(false);
		expect(await h.undo({ run: 1 })).toBe(`baton_undo run #1: restored src/model.ts; ${scratchTest} already undone.`);
		expect(readFileSync(join(cwd, "src/model.ts"), "utf8")).toBe("export const model = 1;\n");
		expect(await h.undo({ run: 9 })).toMatch(/no run #9/);

		expect((await h.turn(LEAD, [{ name: "baton_undo", args: { run: 1 }, output: "ok" }])).isEmpty).toBe(true);
		expect(h.ctx.model?.id).toBe(LEAD);
		const second = await h.turn(LEAD, [{ name: "read", args: { path: "src/model.ts" }, output: "x" }]);
		expect(second.entries[0].content).toMatch(/Speculative run #2/);
		expect(await h.undo({ run: 1 })).toMatch(/only the lead/);
		await h.turn(HELPER, []);
		expect((await h.turn(LEAD, [], { text: "Done." })).isEmpty).toBe(true);

		await h.emit("message_end", { message: { role: "assistant", model: LEAD, usage: { cost: { total: 0.5 }, cacheWrite: 100 } } });
		await h.emit("agent_end", {});
		const summary = JSON.parse(readFileSync(join(cwd, ".pi/baton/sessions/session-1/summary.json"), "utf8"));
		expect(summary.stats).toMatchObject({ runs: 2, helperTurns: 3, helperCalls: 4, blockedWrites: 0, undos: 2 });
		expect(summary.costs[LEAD]).toMatchObject({ requests: 1, usd: 0.5, cacheWrite: 100 });
		expect(summary.runs[0]).toMatchObject({ number: 1, changedFiles: ["src/model.ts", scratchTest], undone: [scratchTest, "src/model.ts"] });
		expect(readFileSync(join(cwd, ".pi/baton/.gitignore"), "utf8")).toBe("*\n");
	});

	it("blocks helper writes outside the lead's files and the scratch directory, and hands back at once", async () => {
		const cwd = project();
		const h = mount(cwd);
		await startTask(h);

		const handoff = await h.turn(LEAD, [{ name: "read", args: { path: "src/model.ts" }, output: "x" }]);
		expect(handoff.entries[0].content).toContain("You may change no project file yet (the lead has written none), only files under .pi/baton/scratch/;");

		const refused = await h.turn(HELPER, [
			{ name: "read", args: { path: "src/model.ts" }, output: "x" },
			{ name: "write", args: { path: "src/store.ts", content: "x" }, output: "blocked", isError: true, effect: write(cwd, "src/store.ts", "x") },
			{ name: "edit", args: { path: "src/model.ts", edits: [] }, output: "blocked", isError: true, effect: write(cwd, "src/model.ts", "y") },
		]);
		expect(refused.blocked).toEqual([
			"Baton: blocked. Only the lead may create or change src/store.ts. Reply with one short line and no tool call.",
			expect.stringMatching(/lead model takes over/),
		]);
		expect(existsSync(join(cwd, "src/store.ts"))).toBe(false);
		expect(readFileSync(join(cwd, "src/model.ts"), "utf8")).toBe("export const model = 1;\n");
		expect(refused.continue).toBe(true);
		expect(h.ctx.model?.id).toBe(LEAD);
		const note: string = refused.entries[0].content;
		expect(note).toContain("It stopped because it tried to write src/store.ts, a file you have not changed with edit/write in this session (blocked, not run): 1 turn(s), 3 tool call(s).");
		expect(note).toContain("2. write src/store.ts → blocked, not run\n3. edit src/model.ts → blocked, not run");
		expect(note).toContain("Files changed with edit/write: none.");

		await h.turn(LEAD, [{ name: "write", args: { path: "src/store.ts", content: "x" }, output: "Wrote", effect: write(cwd, "src/store.ts", "export const store = 1;\n") }]);
		const allowed = await h.turn(HELPER, [{ name: "edit", args: { path: "./src/../src/store.ts", edits: [] }, output: "Edited", effect: write(cwd, "src/store.ts", "export const store = 2;\n") }]);
		expect(allowed.blocked).toEqual([]);
		const escaped = await h.turn(HELPER, [{ name: "write", args: { path: ".pi/baton/scratch/../../../src/other.ts", content: "x" }, output: "blocked", isError: true }]);
		expect(escaped.blocked[0]).toBe("Baton: blocked. Only the lead may create or change src/other.ts. Reply with one short line and no tool call.");
		expect(escaped.entries[0].content).toContain("- modified src/store.ts (+1 −1)");

		await h.emit("agent_end", {});
		const summary = JSON.parse(readFileSync(join(cwd, ".pi/baton/sessions/session-1/summary.json"), "utf8"));
		expect(summary.stats).toMatchObject({ runs: 2, blockedWrites: 2, stopReasons: { "it tried to change a file the lead has not written": 2 } });
		expect(summary.runs.map((run: { blockedWrite?: string }) => run.blockedWrite)).toEqual(["src/store.ts", "src/other.ts"]);
	});

	it("keeps the lead's thinking level for the helper when helperThinking is inherit", async () => {
		process.env.BATON_HELPER_THINKING = "inherit";
		try {
			const h = mount(project());
			await startTask(h);
			await h.turn(LEAD, [READ]);
			expect(h.ctx.model?.id).toBe(HELPER);
			expect(h.thinking.level).toBe("medium");
			await h.turn(HELPER, []);
			expect(h.ctx.model?.id).toBe(LEAD);
			expect(h.thinking.level).toBe("medium");
		} finally {
			delete process.env.BATON_HELPER_THINKING;
		}
	});

	it("ends the run on a helper error, an abort, a user message, or the turn cap", async () => {
		writeFileSync(join(agentDir, "baton.json"), JSON.stringify({ maxHelperTurns: 2 }));
		try {
			const h = mount(project());
			await startTask(h);
			const read = { name: "read", args: { path: "src/model.ts" }, output: "x" };

			await h.turn(LEAD, [read]);
			const failed = await h.turn(HELPER, [], { stopReason: "error", errorMessage: "429 rate\nlimited" });
			expect(failed.continue).toBe(true);
			expect(failed.entries[0].content).toMatch(/stopped because the helper's request failed \(429 rate limited\)/);

			await h.turn(LEAD, [read]);
			const aborted = await h.turn(HELPER, [read], { stopReason: "aborted" });
			expect(aborted.continue).toBeUndefined();
			expect(aborted.entries[0].content).toMatch(/stopped because the user interrupted it/);
			expect(h.ctx.model?.id).toBe(LEAD);

			await h.turn(LEAD, [read]);
			await h.emit("message_end", { message: { role: "user", content: "use canvas instead" } });
			const steered = await h.turn(HELPER, [read]);
			expect(steered.blocked[0]).toMatch(/lead model takes over/);
			expect(steered.entries[0].content).toMatch(/stopped because the user sent a message/);

			await h.turn(LEAD, [read]);
			expect((await h.turn(HELPER, [read])).isEmpty).toBe(true);
			const capped = await h.turn(HELPER, [read]);
			expect(capped.entries[0].content).toMatch(/stopped because it reached the safety cap of 2 helper turns/);
		} finally {
			writeFileSync(join(agentDir, "baton.json"), "{}");
		}
	});

	it("limits the first speculative run to 5 helper turns and later runs to 10 by default", async () => {
		const h = mount(project());
		await startTask(h);
		const read = { name: "read", args: { path: "src/model.ts" }, output: "x" };

		await h.turn(LEAD, [read]);
		for (let i = 1; i < 5; i++) {
			expect((await h.turn(HELPER, [read])).isEmpty).toBe(true);
		}
		const firstCap = await h.turn(HELPER, [read]);
		expect(firstCap.entries[0].content).toMatch(/stopped because it reached the safety cap of 5 helper turns/);

		await h.turn(LEAD, [read]);
		for (let i = 1; i < 10; i++) {
			expect((await h.turn(HELPER, [read])).isEmpty).toBe(true);
		}
		const secondCap = await h.turn(HELPER, [read]);
		expect(secondCap.entries[0].content).toMatch(/stopped because it reached the safety cap of 10 helper turns/);
	});

	it("closes an unfinished run when a new prompt arrives", async () => {
		const h = mount(project());
		await startTask(h);
		await h.turn(LEAD, [{ name: "read", args: { path: "src/model.ts" }, output: "x" }]);
		expect(h.ctx.model?.id).toBe(HELPER);
		const next = await h.emit("before_agent_start", { messageType: "user", prompt: "Also add a score", systemPrompt: "", systemPromptOptions: {} });
		expect(h.ctx.model?.id).toBe(LEAD);
		expect(next.message).toMatchObject({ customType: LEAD_NOTE_TYPE });
		expect(next.message.content).toMatch(/Speculative run #1[\s\S]*stopped because a new prompt arrived/);
	});

	it("never hands over when speculation is off, on a final answer, or after a failed lead turn", async () => {
		const h = mount(project());
		await startTask(h);
		expect((await h.turn(LEAD, [], { text: "Done." })).isEmpty).toBe(true);
		expect((await h.turn(LEAD, [{ name: "read", args: { path: "a" } }], { stopReason: "error" })).isEmpty).toBe(true);

		process.env.BATON_SPEC = "0";
		try {
			const off = mount(project());
			await startTask(off);
			expect((await off.turn(LEAD, [{ name: "read", args: { path: "a" }, output: "x" }])).isEmpty).toBe(true);
			expect(off.ctx.model?.id).toBe(LEAD);
		} finally {
			delete process.env.BATON_SPEC;
		}
	});
});

const READ = { name: "read", args: { path: "src/model.ts" }, output: "x" };
const LEAD_USED_CACHE = { cacheRead: 30_000, cacheWrite: 2_000 };
const HOUR_MS = 3_600_000;

const journalEvents = (cwd: string, kind: string) =>
	readFileSync(join(cwd, ".pi/baton/sessions/session-1/events.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.filter((event) => event.kind === kind);

describe("lead cache keepalive", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("re-sends the lead's last request, timed from that request, while the helper works, and stops with the run", async () => {
		const cwd = project();
		const h = mount(cwd);
		await startTask(h);
		await h.turn(LEAD, [READ], { usage: LEAD_USED_CACHE, toolsMs: 100_000 });
		await h.turn(HELPER, [READ]);
		await vi.advanceTimersByTimeAsync(189_999);
		expect(h.pings).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		expect(h.pings).toHaveLength(1);
		expect(h.pings[0]).toMatchObject({ model: { id: LEAD }, payload: { model: LEAD, request: 1 }, sessionId: "session-1" });
		expect(h.pings[0]!.signal.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(290_000);
		expect(h.pings.map((ping) => ping.payload)).toEqual([
			{ model: LEAD, request: 1 },
			{ model: LEAD, request: 1 },
		]);

		await h.turn(HELPER, [], { text: "Done." });
		await vi.advanceTimersByTimeAsync(HOUR_MS);
		expect(h.pings).toHaveLength(2);
		const ping = { run: 1, model: LEAD, sincePreviousMs: 290_000, cacheRead: 40_000, cacheWrite: 0, cost: 0.008 };
		expect(journalEvents(cwd, "cache_keepalive")).toEqual([expect.objectContaining(ping), expect.objectContaining(ping)]);
		const summary = JSON.parse(readFileSync(join(cwd, ".pi/baton/sessions/session-1/summary.json"), "utf8"));
		expect(summary.stats.cacheKeepalives).toBe(2);
		expect(summary.costs[LEAD]).toMatchObject({ requests: 2, cacheRead: 80_000 });
		expect(summary.costs[LEAD].usd).toBeCloseTo(0.016);
	});

	it("does not ping without a run, when the lead's request used no prompt cache, or when it is off", async () => {
		const h = mount(project());
		await startTask(h);
		await h.turn(LEAD, [], { text: "Done.", usage: LEAD_USED_CACHE });
		await vi.advanceTimersByTimeAsync(HOUR_MS);
		await h.turn(LEAD, [READ]);
		await vi.advanceTimersByTimeAsync(HOUR_MS);
		expect(h.pings).toHaveLength(0);

		process.env.BATON_CACHE_KEEPALIVE_MS = "0";
		try {
			const off = mount(project());
			await startTask(off);
			await off.turn(LEAD, [READ], { usage: LEAD_USED_CACHE });
			await vi.advanceTimersByTimeAsync(HOUR_MS);
			expect(off.pings).toHaveLength(0);
		} finally {
			delete process.env.BATON_CACHE_KEEPALIVE_MS;
		}
	});

	it("stops on a new prompt, a user interrupt, a session restart, the agent's end, and pi's shutdown", async () => {
		const h = mount(project());
		const startRun = () => h.turn(LEAD, [READ], { usage: LEAD_USED_CACHE });
		const pingsWithinAnHour = async () => {
			await vi.advanceTimersByTimeAsync(HOUR_MS);
			return h.pings.length;
		};
		await startTask(h);

		await startRun();
		await h.emit("before_agent_start", { messageType: "user", prompt: "Also add a score", systemPrompt: "", systemPromptOptions: {} });
		expect(await pingsWithinAnHour()).toBe(0);

		await startRun();
		await h.turn(HELPER, [READ], { stopReason: "aborted" });
		expect(await pingsWithinAnHour()).toBe(0);

		await startRun();
		await startTask(h);
		expect(await pingsWithinAnHour()).toBe(0);

		await startRun();
		await h.emit("agent_end", {});
		expect(await pingsWithinAnHour()).toBe(0);

		await startTask(h);
		await startRun();
		await h.emit("session_shutdown", { reason: "quit" });
		expect(await pingsWithinAnHour()).toBe(0);
	});
});

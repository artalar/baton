import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_TYPE } from "../src/context.ts";
import baton from "../src/index.ts";
import { ALERT_INTRO, followerSystemNote, leadSystemNote } from "../src/notes.ts";

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
type Call = { name: string; args: Record<string, unknown>; output?: string; isError?: boolean };
type ModelRef = { id: string; provider: string };
type StreamOptions = { onPayload: (payload: unknown, model: ModelRef) => unknown; sessionId?: string; signal: AbortSignal };
type Ping = { model: ModelRef; payload: unknown; sessionId?: string; signal: AbortSignal };

const PING_USAGE = { input: 12, output: 2, cacheRead: 40_000, cacheWrite: 0, totalTokens: 40_014, cost: { total: 0.008 } };

function mount(cwd: string) {
	const handlers = new Map<string, Handler[]>();
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
		registerTool() {},
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
	 * Simulates one assistant turn: the provider request, then turn_end.
	 * `toolsMs` advances the fake clock between the request and turn_end, as long tool calls do.
	 */
	const turn = async (
		model: string,
		calls: Call[],
		options: { text?: string; thinking?: string; stopReason?: string; errorMessage?: string; usage?: Record<string, number>; toolsMs?: number } = {},
	) => {
		await emit("before_provider_request", { payload: { model, request: ++requestCounter } });
		const withIds = calls.map((call) => ({ ...call, id: `call-${++callCounter}` }));
		if (options.toolsMs) await vi.advanceTimersByTimeAsync(options.toolsMs);
		const content = [
			...(options.thinking ? [{ type: "thinking", thinking: options.thinking }] : []),
			...(options.text ? [{ type: "text", text: options.text }] : []),
			...withIds.map((call) => ({ type: "toolCall", id: call.id, name: call.name, arguments: call.args })),
		];
		const result = await emit("turn_end", {
			message: {
				role: "assistant",
				model,
				stopReason: options.stopReason ?? (withIds.length ? "toolUse" : "stop"),
				errorMessage: options.errorMessage,
				usage: options.usage,
				content,
			},
			toolResults: withIds.filter((call) => call.output !== undefined).map((call) => ({ toolCallId: call.id, isError: !!call.isError, content: [{ type: "text", text: call.output }] })),
		});
		return Object.assign(result ?? {}, { isEmpty: result === undefined });
	};
	return { ctx, emit, turn, pings, thinking };
}

async function startTask(h: ReturnType<typeof mount>, prompt = "Build tetris") {
	await h.emit("session_start", { reason: "startup" });
	return h.emit("before_agent_start", { messageType: "user", prompt, systemPrompt: "BASE PROMPT", systemPromptOptions: {} });
}

const systemSection = async (h: ReturnType<typeof mount>) => {
	const projected = await h.emit("context_with_system", { messages: [{ role: "system", content: "BASE PROMPT", sections: { identity: "You are pi." } }] });
	return projected?.messages?.[0]?.sections?.baton as string | undefined;
};

const READ = { name: "read", args: { path: "src/model.ts" }, output: "file body" };

describe("speculative runs in a pi session", () => {
	it("switches to the follower after a lead turn with tool calls, and not after one without", async () => {
		const h = mount(project());
		expect(await startTask(h)).toBeUndefined();
		expect(h.ctx.model?.id).toBe(LEAD);
		expect(await systemSection(h)).toBe(leadSystemNote());

		expect((await h.turn(LEAD, [], { text: "The board is ready." })).isEmpty).toBe(true);
		expect(h.ctx.model?.id).toBe(LEAD);

		expect((await h.turn(LEAD, [READ], { stopReason: "error" })).isEmpty).toBe(true);
		expect(h.ctx.model?.id).toBe(LEAD);
		expect((await h.turn(LEAD, [READ], { stopReason: "aborted" })).isEmpty).toBe(true);
		expect(h.ctx.model?.id).toBe(LEAD);

		const handoff = await h.turn(LEAD, [READ], { text: "Reading the model." });
		expect(handoff.isEmpty).toBe(true);
		expect(h.ctx.model?.id).toBe(HELPER);
		expect(h.thinking.level).toBe("low");
		expect(await systemSection(h)).toBe(followerSystemNote());
	});

	it("hands back when the follower stops calling tools, with an alert of inputs and outputs and no follower thinking", async () => {
		const h = mount(project());
		await startTask(h);
		await h.turn(LEAD, [READ]);
		const working = await h.turn(
			HELPER,
			[
				{ name: "read", args: { path: "src/model.ts" }, output: "MODEL SOURCE" },
				{ name: "bash", args: { command: "npm test" }, isError: true, output: "FAIL model.test.ts" },
			],
			{ thinking: "FOLLOWER PRIVATE PLAN", text: "Updating the model." },
		);
		expect(working.isEmpty).toBe(true);
		expect(h.ctx.model?.id).toBe(HELPER);

		const back = await h.turn(HELPER, [], { thinking: "DONE THINKING", text: "All checks are green." });
		expect(back.continue).toBe(true);
		expect(h.ctx.model?.id).toBe(LEAD);
		expect(h.thinking).toEqual({ level: "medium", history: ["medium", "low", "medium"] });
		expect(back.entries).toHaveLength(1);
		expect(back.entries[0].customType).toBe(ALERT_TYPE);
		expect(back.entries[0].content).toBe(
			`${ALERT_INTRO}\n1. read\ninput: {"path":"src/model.ts"}\noutput: MODEL SOURCE\n2. bash\ninput: {"command":"npm test"}\noutput: FAIL model.test.ts`,
		);
		expect(back.entries[0].content).not.toMatch(/FOLLOWER PRIVATE PLAN|DONE THINKING|All checks are green|Updating the model/);
		expect(await systemSection(h)).toBe(leadSystemNote());
	});

	it("marks follower output that the alert had to cut", async () => {
		const h = mount(project());
		await startTask(h);
		await h.turn(LEAD, [READ]);
		const output = "y".repeat(200_000 + 1);
		await h.turn(HELPER, [{ name: "bash", args: { command: "cat big" }, output }]);
		const back = await h.turn(HELPER, []);
		const alert = back.entries[0].content as string;
		const recorded = alert.slice(alert.indexOf("output: ") + "output: ".length);
		expect(recorded.startsWith("y".repeat(200_000))).toBe(true);
		expect(recorded.endsWith("\n[output cut]")).toBe(true);
		expect(recorded.includes("y".repeat(200_001))).toBe(false);
	});

	it("keeps a user message from the follower run in the lead view, beside the alert", async () => {
		const h = mount(project());
		await startTask(h);
		await h.turn(LEAD, [READ]);
		await h.emit("message_end", { message: { role: "user", content: "use canvas instead" } });
		expect((await h.turn(HELPER, [READ], { thinking: "SECRET" })).isEmpty).toBe(true);
		expect(h.ctx.model?.id).toBe(HELPER);

		const messages = [
			{
				role: "assistant",
				model: LEAD,
				content: [
					{ type: "thinking", thinking: "LEAD PLAN", thinkingSignature: "sig-lead" },
					{ type: "toolCall", id: "lead-1", name: "read", arguments: { path: "src/model.ts" } },
				],
			},
			{ role: "toolResult", toolCallId: "lead-1", content: [{ type: "text", text: "file body" }] },
			{ role: "user", content: "use canvas instead" },
			{
				role: "assistant",
				model: HELPER,
				content: [
					{ type: "thinking", thinking: "SECRET" },
					{ type: "toolCall", id: "h1", name: "read", arguments: { path: "src/model.ts" } },
				],
			},
			{ role: "toolResult", toolCallId: "h1", content: [{ type: "text", text: "file body" }] },
		];
		const followerView = await h.emit("context", { messages });
		expect(JSON.stringify(followerView.messages)).toContain("LEAD PLAN");
		expect(JSON.stringify(followerView.messages)).toContain("use canvas instead");
		expect(JSON.stringify(followerView.messages)).toContain("file body");
		expect(JSON.stringify(followerView.messages)).not.toContain("SECRET");

		const back = await h.turn(HELPER, []);
		const alert = back.entries[0].content as string;
		const leadView = await h.emit("context", {
			messages: [...followerView.messages, { role: "custom", customType: ALERT_TYPE, content: alert }],
		});
		expect(leadView.messages.map((message: { role: string }) => message.role)).toEqual(["assistant", "toolResult", "user", "custom"]);
		expect(leadView.messages[2].content).toBe("use canvas instead");
		expect(leadView.messages[3].content).toBe(alert);
		expect(leadView.messages[0].content[0]).toEqual({ type: "thinking", thinking: "LEAD PLAN", thinkingSignature: "sig-lead" });
		expect(JSON.stringify(leadView.messages)).not.toContain("SECRET");
		expect(JSON.stringify(leadView.messages)).not.toContain('"id":"h1"');
	});

	it("omits alerts again when the follower runs a second time", async () => {
		const h = mount(project());
		await startTask(h);
		await h.turn(LEAD, [READ]);
		const firstAlert = (await h.turn(HELPER, [])).entries[0].content as string;
		await h.turn(LEAD, [READ]);
		expect(h.ctx.model?.id).toBe(HELPER);
		const duringSecond = await h.emit("context", {
			messages: [
				{ role: "assistant", model: LEAD, content: [{ type: "thinking", thinking: "LEAD PLAN" }, { type: "toolCall", id: "l2" }] },
				{ role: "custom", customType: ALERT_TYPE, content: firstAlert },
				{ role: "custom", customType: ALERT_TYPE, content: "ALERT TWO" },
				{ role: "assistant", model: HELPER, content: [{ type: "thinking", thinking: "AGAIN" }, { type: "toolCall", id: "h2" }] },
				{ role: "user", content: "still here" },
			],
		});
		const encoded = JSON.stringify(duringSecond.messages);
		expect(encoded).not.toContain(ALERT_INTRO);
		expect(encoded).not.toContain("ALERT TWO");
		expect(encoded).not.toContain("AGAIN");
		expect(encoded).toContain("LEAD PLAN");
		expect(encoded).toContain("still here");
		expect(encoded).toContain("h2");
	});

	it("keeps the lead's thinking level for the follower when helperThinking is inherit", async () => {
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

	it("hands back on a follower error, an abort, or the turn cap, and not because the user spoke", async () => {
		writeFileSync(join(agentDir, "baton.json"), JSON.stringify({ maxHelperTurns: 2 }));
		try {
			const h = mount(project());
			await startTask(h);

			await h.turn(LEAD, [READ]);
			const failed = await h.turn(HELPER, [], { stopReason: "error", errorMessage: "429 rate\nlimited" });
			expect(failed.continue).toBe(true);
			expect(failed.entries[0].content).toBe(ALERT_INTRO);
			expect(h.ctx.model?.id).toBe(LEAD);
			expect(journalEvents(h.ctx.cwd, "run_end")[0].stopReason).toBe("the follower's request failed (429 rate limited)");

			await h.turn(LEAD, [READ]);
			const aborted = await h.turn(HELPER, [READ], { stopReason: "aborted" });
			expect(aborted.continue).toBeUndefined();
			expect(h.ctx.model?.id).toBe(LEAD);
			expect(aborted.entries[0].content).toContain('1. read\ninput: {"path":"src/model.ts"}\noutput: file body');

			await h.turn(LEAD, [READ]);
			await h.emit("message_end", { message: { role: "user", content: "use canvas instead" } });
			expect((await h.turn(HELPER, [READ])).isEmpty).toBe(true);
			expect(h.ctx.model?.id).toBe(HELPER);
			const capped = await h.turn(HELPER, [READ]);
			expect(capped.continue).toBe(true);
			expect(h.ctx.model?.id).toBe(LEAD);
			expect(capped.entries[0].content).toContain("1. read");
			expect(capped.entries[0].content).toContain("2. read");
			expect(journalEvents(h.ctx.cwd, "run_end").at(-1).stopReason).toBe("it reached the safety cap of 2 follower turns");
		} finally {
			writeFileSync(join(agentDir, "baton.json"), "{}");
		}
	});

	it("limits the first follower run to 5 turns and later runs to 10 by default", async () => {
		const cwd = project();
		const h = mount(cwd);
		await startTask(h);

		await h.turn(LEAD, [READ]);
		for (let i = 1; i < 5; i++) {
			expect((await h.turn(HELPER, [READ])).isEmpty).toBe(true);
		}
		const firstCap = await h.turn(HELPER, [READ]);
		expect(firstCap.continue).toBe(true);
		expect(h.ctx.model?.id).toBe(LEAD);
		expect(journalEvents(cwd, "run_end")[0].stopReason).toBe("it reached the safety cap of 5 follower turns");

		await h.turn(LEAD, [READ]);
		for (let i = 1; i < 10; i++) {
			expect((await h.turn(HELPER, [READ])).isEmpty).toBe(true);
		}
		const secondCap = await h.turn(HELPER, [READ]);
		expect(h.ctx.model?.id).toBe(LEAD);
		expect(journalEvents(cwd, "run_end")[1].stopReason).toBe("it reached the safety cap of 10 follower turns");
	});

	it("closes an unfinished run when a new prompt arrives", async () => {
		const h = mount(project());
		await startTask(h);
		await h.turn(LEAD, [READ]);
		await h.turn(HELPER, [READ]);
		expect(h.ctx.model?.id).toBe(HELPER);
		const next = await h.emit("before_agent_start", { messageType: "user", prompt: "Also add a score", systemPrompt: "", systemPromptOptions: {} });
		expect(h.ctx.model?.id).toBe(LEAD);
		expect(next.message).toMatchObject({ customType: ALERT_TYPE });
		expect(next.message.content).toContain('1. read\ninput: {"path":"src/model.ts"}\noutput: file body');
		expect(next.systemPrompt).toBeUndefined();
	});

	it("does not inject a section or switch the model when speculation is off", async () => {
		process.env.BATON_SPEC = "0";
		try {
			const off = mount(project());
			const started = await startTask(off);
			expect(started).toBeUndefined();
			expect(off.ctx.model).toBeUndefined();
			expect(await systemSection(off)).toBeUndefined();
			expect((await off.turn(LEAD, [READ])).isEmpty).toBe(true);
			expect(off.ctx.model).toBeUndefined();
			const view = await off.emit("context", {
				messages: [{ role: "custom", customType: ALERT_TYPE, content: "ALERT" }, { role: "assistant", model: HELPER, content: [{ type: "thinking", thinking: "SECRET" }] }],
			});
			expect(view).toBeUndefined();
		} finally {
			delete process.env.BATON_SPEC;
		}
	});

	it("records run stats without a file journal of the follower's edits", async () => {
		const cwd = project();
		const h = mount(cwd);
		await startTask(h);
		await h.turn(LEAD, [READ]);
		await h.turn(HELPER, [{ name: "write", args: { path: "src/store.ts", content: "x" }, output: "Wrote" }]);
		await h.turn(HELPER, []);
		await h.emit("message_end", { message: { role: "assistant", model: LEAD, usage: { cost: { total: 0.5 }, cacheWrite: 100 } } });
		await h.emit("agent_end", {});
		const summary = JSON.parse(readFileSync(join(cwd, ".pi/baton/sessions/session-1/summary.json"), "utf8"));
		expect(summary.stats).toMatchObject({ runs: 1, helperTurns: 2, helperCalls: 1, cacheKeepalives: 0 });
		expect(summary.stats.blockedWrites).toBeUndefined();
		expect(summary.stats.undos).toBeUndefined();
		expect(summary.runs[0]).toEqual({ number: 1, stopReason: "the follower ended its turn without tool calls", turns: 2, calls: 1 });
		expect(summary.costs[LEAD]).toMatchObject({ requests: 1, usd: 0.5, cacheWrite: 100 });
		expect(existsSync(join(cwd, ".pi/baton/scratch"))).toBe(false);
		expect(readFileSync(join(cwd, ".pi/baton/.gitignore"), "utf8")).toBe("*\n");
	});
});

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

	it("re-sends the lead's last request, timed from that request, while the follower works, and stops with the run", async () => {
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

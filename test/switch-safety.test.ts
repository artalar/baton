import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, DEFAULT_SWITCH, decideTurn, initialSwitchState, isLeadModel, type TurnInput } from "../src/pi/switch-core.ts";
import batonSwitch, { envFlag, journalInsideCwd, keepaliveBody, loadSwitchConfig, projectCheckCommands, runChecks, runCommandGroup } from "../src/pi/switch.ts";

const c = (id: string, name: string, args: Record<string, unknown> = {}): Call => ({ id, name, args });
let tn = 0;
const turn = (p: Partial<TurnInput>): TurnInput => ({ turn: tn++, now: 1000 + tn, text: "", calls: [], results: [], empty: false, ...p });

const saved: Record<string, string | undefined> = {};
function rememberEnv(name: string) {
	if (!(name in saved)) saved[name] = process.env[name];
}
function setEnv(name: string, value: string | undefined) {
	rememberEnv(name);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

afterEach(() => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("envFlag", () => {
	it("accepts 1/on/true/yes and 0/off/false/no", () => {
		expect(envFlag("BATON_SPEC", { BATON_SPEC: "yes" })).toBe(true);
		expect(envFlag("BATON_SPEC", { BATON_SPEC: "TRUE" })).toBe(true);
		expect(envFlag("BATON_SPEC", { BATON_SPEC: "off" })).toBe(false);
		expect(envFlag("BATON_SPEC", { BATON_SPEC: "0" })).toBe(false);
		expect(envFlag("BATON_SPEC", { BATON_SPEC: "maybe" })).toBeUndefined();
		expect(envFlag("BATON_SPEC", {})).toBeUndefined();
	});
});

describe("loadSwitchConfig", () => {
	function isolated(project?: unknown, user?: unknown) {
		const cwd = mkdtempSync(join(tmpdir(), "baton-cfg-"));
		const agent = mkdtempSync(join(tmpdir(), "baton-agent-"));
		setEnv("PI_CODING_AGENT_DIR", agent);
		if (user) writeFileSync(join(agent, "baton.json"), JSON.stringify(user));
		if (project) {
			mkdirSync(join(cwd, ".pi"));
			writeFileSync(join(cwd, ".pi", "baton.json"), JSON.stringify(project));
		}
		return cwd;
	}

	it("takes spend keys and journalDir from the user file or env, not the project", () => {
		const cwd = isolated(
			{
				journalDir: "/tmp/evil-journal",
				switch: {
					lead: "openrouter/evil/lead",
					helper: "openrouter/evil/helper",
					cacheKeepaliveMs: 1,
					cacheKeepaliveCostUsd: 9,
					budgetUsd: 0.01,
					reserveUsd: 0,
					helperCostFactor: 99,
					endgameUsd: 0,
					fsGuardMaxRevert: 0,
					maxReadCalls: 3,
					spec: { gate: { on: true } },
					jev: { model: "evil/jev", fallbackModel: "evil/fb", endpoint: "https://evil.example", thr: { block: 0.99 } },
				},
			},
			{ journalDir: ".pi/from-user", switch: { lead: "openrouter/anthropic/claude-opus-5.5", budgetUsd: 2 } },
		);
		const warnings: string[] = [];
		const cfg = loadSwitchConfig(cwd, (m) => warnings.push(m));
		expect(cfg.lead).toBe("openrouter/anthropic/claude-opus-5.5");
		expect(cfg.helper).toBe(DEFAULT_SWITCH.helper);
		expect(cfg.cacheKeepaliveMs).toBe(DEFAULT_SWITCH.cacheKeepaliveMs);
		expect(cfg.cacheKeepaliveCostUsd).toBe(DEFAULT_SWITCH.cacheKeepaliveCostUsd);
		expect(cfg.budgetUsd).toBe(2);
		expect(cfg.reserveUsd).toBe(DEFAULT_SWITCH.reserveUsd);
		expect(cfg.helperCostFactor).toBe(DEFAULT_SWITCH.helperCostFactor);
		expect(cfg.endgameUsd).toBe(DEFAULT_SWITCH.endgameUsd);
		expect(cfg.fsGuardMaxRevert).toBe(DEFAULT_SWITCH.fsGuardMaxRevert);
		expect(cfg.maxReadCalls).toBe(3);
		expect(cfg.spec.gate).toEqual({ on: true, free: DEFAULT_SWITCH.spec.gate.free, thr: DEFAULT_SWITCH.spec.gate.thr });
		expect(cfg.jev.model).toBe(DEFAULT_SWITCH.jev.model);
		expect(cfg.jev.fallbackModel).toBe(DEFAULT_SWITCH.jev.fallbackModel);
		expect(cfg.jev.thr.block).toBe(0.99);
		expect(cfg.journalDir).toBe(".pi/from-user");
		expect(warnings.join("\n")).toMatch(/switch\.lead/);
		expect(warnings.join("\n")).toMatch(/switch\.jev\.model/);
		expect(warnings.join("\n")).toMatch(/switch\.jev\.endpoint/);
		expect(warnings.join("\n")).toMatch(/journalDir/);
	});

	it("rejects a journalDir outside cwd and warns on a non-numeric budget", () => {
		const cwd = isolated(undefined, { journalDir: "/tmp/outside-baton" });
		setEnv("BATON_BUDGET_USD", "nope");
		const warnings: string[] = [];
		const cfg = loadSwitchConfig(cwd, (m) => warnings.push(m));
		expect(cfg.journalDir).toBe(".pi/baton");
		expect(cfg.budgetUsd).toBe(0);
		expect(warnings.join("\n")).toMatch(/BATON_BUDGET_USD/);
		expect(warnings.join("\n")).toMatch(/outside/);
		expect(journalInsideCwd(cwd, ".pi/baton")).toBe(true);
		expect(journalInsideCwd(cwd, "/tmp/outside-baton")).toBe(false);
	});

	it("deep-merges spec.gate and spec.adapt and honors env flags", () => {
		const cwd = isolated({ switch: { spec: { gate: { thr: 0.2 }, adapt: { min: 4 } } } });
		setEnv("BATON_SPEC", "yes");
		setEnv("BATON_SPEC_GATE", "true");
		setEnv("BATON_SPEC_ADAPT", "on");
		setEnv("BATON_JEV", "no");
		setEnv("BATON_READ", "false");
		setEnv("BATON_EDIT", "off");
		setEnv("BATON_LEAD", "openrouter/anthropic/from-env");
		const cfg = loadSwitchConfig(cwd, () => {});
		expect(cfg.spec.enabled).toBe(true);
		expect(cfg.spec.gate).toEqual({ on: true, free: 3, thr: 0.2 });
		expect(cfg.spec.adapt).toMatchObject({ on: true, min: 4, max: DEFAULT_SWITCH.spec.adapt.max, init: DEFAULT_SWITCH.spec.adapt.init });
		expect(cfg.jev.enabled).toBe(false);
		expect(cfg.readTool).toBe(false);
		expect(cfg.editTool).toBe(false);
		expect(cfg.editIntents).toBe(false);
		expect(cfg.lead).toBe("openrouter/anthropic/from-env");
	});
});

describe("isLeadModel", () => {
	it("matches a lead ref with or without the openrouter prefix", () => {
		expect(isLeadModel("openrouter/anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5")).toBe(true);
		expect(isLeadModel("anthropic/claude-opus-5.5", "openrouter/anthropic/claude-opus-5.5")).toBe(true);
		expect(isLeadModel("anthropic/claude-opus-5.5", "anthropic/claude-opus-5.5")).toBe(true);
		expect(isLeadModel("z-ai/glm-5.3-flash", "anthropic/claude-opus-5.5")).toBe(false);
		expect(isLeadModel("opus", "openrouter/anthropic/claude-opus-5.5")).toBe(false);
	});
});

describe("stretch caps", () => {
	it("stops length-cap continuations after maxLengthContinuations", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		for (let i = 0; i < DEFAULT_SWITCH.maxLengthContinuations; i++) {
			const d = decideTurn(s, turn({ text: "partial", lengthStop: true }), DEFAULT_SWITCH);
			expect(d.continue).toBe(true);
		}
		const stopped = decideTurn(s, turn({ text: "partial", lengthStop: true }), DEFAULT_SWITCH);
		expect(stopped.continue).toBeUndefined();
		expect(stopped.reason).toMatch(/continuation limit/);
		decideTurn(s, turn({ text: "done" }), DEFAULT_SWITCH);
		expect(s.metrics.lengthContinuations).toBe(0);
	});

	it("caps an implement stretch by call count when there is no time limit", () => {
		const s = initialSwitchState(0);
		s.phase = "implement";
		s.stretchCalls = DEFAULT_SWITCH.maxImplementCalls - 1;
		expect(decideTurn(s, turn({ calls: [c("e", "edit", { path: "a.ts" })] }), DEFAULT_SWITCH).to).toBe("lead");
	});

	it("stops handing baton_edit to the helper after maxEditTool", () => {
		const s = initialSwitchState(0);
		s.phase = "lead";
		s.editTool = { calls: DEFAULT_SWITCH.maxEditTool, ok: 0, failed: 0 };
		const d = decideTurn(s, turn({ calls: [c("be", "baton_edit", { request: "change the score" })] }), DEFAULT_SWITCH);
		expect(d.to).toBe("lead");
		expect(s.stubs.be).toMatch(/limit of/);
		expect(s.phase).toBe("lead");
	});
});

describe("keepalive body", () => {
	it("sets max_tokens 1 and keeps reasoning", () => {
		const payload = { model: "anthropic/claude-opus-5.5", max_tokens: 16000, max_completion_tokens: 16000, reasoning: { max_tokens: 1024 }, messages: [{ role: "user", content: "same" }] };
		const body = keepaliveBody(payload);
		expect(body.max_tokens).toBe(1);
		expect(body.stream).toBe(true);
		expect(body.reasoning).toEqual({ max_tokens: 1024 });
		expect(body.messages).toEqual(payload.messages);
		expect(body.max_completion_tokens).toBeUndefined();
		expect(payload.max_tokens).toBe(16000);
	});
});

describe("runChecks", () => {
	it("uses npx --no-install tsc when there is a tsconfig and no typecheck script", () => {
		const cwd = mkdtempSync(join(tmpdir(), "baton-chk-"));
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e 'process.exit(0)'" } }));
		writeFileSync(join(cwd, "tsconfig.json"), "{}");
		expect(projectCheckCommands(cwd)).toEqual(["npx --no-install tsc --noEmit", "npm test --silent"]);
	});

	it("kills a timed-out command's process group", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "baton-chk-"));
		const t0 = Date.now();
		const r = await runCommandGroup("sleep 30", cwd, 300);
		expect(r.timedOut).toBe(true);
		expect(Date.now() - t0).toBeLessThan(3000);
	});

	it("returns check output", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "baton-chk-"));
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e 'console.log(42)'" } }));
		const r = await runChecks(cwd, undefined, 10_000);
		expect(r?.ok).toBe(true);
		expect(r?.text).toContain("42");
	});
});

describe("switch session budget and keepalive", () => {
	function harness(cwd: string) {
		const handlers = new Map<string, ((e: unknown, ctx: unknown) => unknown)[]>();
		const setModel = vi.fn(async () => true);
		const pi = {
			on(event: string, fn: (e: unknown, ctx: unknown) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(fn);
				handlers.set(event, list);
			},
			registerTool() {},
			setModel,
		};
		batonSwitch(pi as never);
		const notify = vi.fn();
		const abort = vi.fn();
		const ctx = {
			cwd,
			hasUI: true,
			ui: { notify },
			abort,
			signal: undefined,
			model: undefined as { id: string; provider: string } | undefined,
			modelRegistry: { find: () => ({ id: "anthropic/claude-opus-5.5", provider: "openrouter" }) },
		};
		const emit = async (event: string, e: unknown) => {
			for (const fn of handlers.get(event) ?? []) await fn(e, ctx);
		};
		return { emit, setModel, notify, abort, handlers };
	}

	it("stops again on the next prompt after the budget fires", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "baton-bud-"));
		const agent = mkdtempSync(join(tmpdir(), "baton-agent-"));
		setEnv("PI_CODING_AGENT_DIR", agent);
		setEnv("BATON_BUDGET_USD", "1");
		setEnv("BATON_SWITCH_START", undefined);
		const h = harness(cwd);
		await h.emit("before_agent_start", { messageType: "user", prompt: "build it", systemPrompt: "" });
		const models = h.setModel.mock.calls.length;
		await h.emit("message_end", { message: { role: "assistant", model: "anthropic/claude-opus-5.5", usage: { cost: { total: 5 } } } });
		expect(h.abort).toHaveBeenCalled();
		h.abort.mockClear();
		h.notify.mockClear();
		await h.emit("before_agent_start", { messageType: "user", prompt: "again", systemPrompt: "" });
		expect(h.abort).toHaveBeenCalled();
		expect(h.notify).toHaveBeenCalled();
		expect(String(h.notify.mock.calls[0]?.[0])).toMatch(/budget stop/i);
		expect(h.setModel.mock.calls.length).toBe(models);
		await h.emit("session_shutdown", { reason: "quit" });
	});

	it("pings the lead cache only while a run is active, only for an openrouter lead, and only counts HTTP 2xx", async () => {
		vi.useFakeTimers();
		const cwd = mkdtempSync(join(tmpdir(), "baton-ka-"));
		const agent = mkdtempSync(join(tmpdir(), "baton-agent-"));
		setEnv("PI_CODING_AGENT_DIR", agent);
		setEnv("BATON_BUDGET_USD", undefined);
		setEnv("BATON_SWITCH_START", "lead");
		setEnv("OPENROUTER_API_KEY", "test-key");
		writeFileSync(join(agent, "baton.json"), JSON.stringify({ switch: { cacheKeepaliveMs: 1000, cacheKeepaliveMax: 2, cacheKeepaliveCostUsd: 0.5 } }));
		const bodies: Record<string, unknown>[] = [];
		const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
			if (!String(url).includes("/chat/completions")) return new Response("no", { status: 500 });
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			if (bodies.length === 1) return new Response("nope", { status: 500 });
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{}}]}\n'));
					controller.close();
				},
			});
			return new Response(stream, { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const h = harness(cwd);
		await h.emit("before_agent_start", { messageType: "user", prompt: "build it", systemPrompt: "" });
		await h.emit("before_provider_request", { payload: { model: "anthropic/claude-opus-5.5", max_tokens: 16000, reasoning: { max_tokens: 1024 }, messages: [{ role: "user", content: "hi" }] } });
		await h.emit("turn_end", {
			message: { role: "assistant", stopReason: "stop", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } }] },
			toolResults: [{ toolCallId: "r1", isError: false, content: [{ type: "text", text: "export const a = 1" }] }],
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.max_tokens).toBe(1);
		expect(bodies[0]?.reasoning).toEqual({ max_tokens: 1024 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(bodies).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(bodies).toHaveLength(2);
		await h.emit("agent_end", {});
		const summary = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(cwd, ".pi/baton/switch-summary.json"), "utf8"))) as { budget: { jevUsd: number } };
		expect(summary.budget.jevUsd).toBeCloseTo(0.5);
		await h.emit("session_shutdown", { reason: "quit" });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(bodies).toHaveLength(2);

		const quiet = mkdtempSync(join(tmpdir(), "baton-ka-"));
		writeFileSync(join(agent, "baton.json"), JSON.stringify({ switch: { lead: "anthropic/claude-opus-5.5", cacheKeepaliveMs: 1000, cacheKeepaliveMax: 5 } }));
		const h2 = harness(quiet);
		const before = bodies.length;
		await h2.emit("before_agent_start", { messageType: "user", prompt: "build it", systemPrompt: "" });
		await h2.emit("before_provider_request", { payload: { model: "anthropic/claude-opus-5.5", messages: [{ role: "user", content: "hi" }], reasoning: { effort: "low" } } });
		await h2.emit("turn_end", {
			message: { role: "assistant", stopReason: "stop", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } }] },
			toolResults: [{ toolCallId: "r1", isError: false, content: [{ type: "text", text: "x" }] }],
		});
		await vi.advanceTimersByTimeAsync(20_000);
		expect(bodies.length).toBe(before);
		await h2.emit("session_shutdown", { reason: "quit" });
	});
});

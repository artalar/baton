/**
 * Baton "switch" mode for pi: in-session model switching, one session, the lead model (Opus) leads.
 *   read (helper) → lead plans + writes → debug/verify (helper, escalates after N red cycles) → lead … →
 *   review (helper) → final short check (lead, optional) → done.
 * Load with `-e src/pi/switch.ts`, or `-e src/pi/index.ts` with BATON_MODE=switch.
 * Config: `.pi/baton.json` → { "switch": { …SwitchConfig } }. Journal: `<journalDir>/switch.jsonl`, summary in switch-summary.json.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decide, type JevQuestions, type JevResult } from "../core/jev.ts";
import { openRouterComplete, openRouterModelId } from "../core/openrouter.ts";
import { agentDir, parseModelRef } from "./config.ts";
import { buildState, buildSummary, CALL_QUESTIONS, callSummary, gateFromAnswers, recordCall, summaryPrompt, SPEC_CONT_QUESTIONS, SPEC_EST_QUESTIONS, SPEC_QUESTIONS, TURN_QUESTIONS, turnJevFromAnswers, type TurnJev } from "./jev-policy.ts";
import { classifyEffects, diffSnaps, diffVsHead, revertTo, type Snap, snapshot } from "./fsguard.ts";
import { addCost, anchorCache, applyJevGate, budgetSpend, type Call, type CostRow, capMaxTokens, capReasoning, countCacheControl, DEFAULT_SWITCH, executedSegments, decideTurn, gateCall, initialSwitchState, isHelper, isLeadModel, LEAD_EDIT_TOOL_NOTE, LEAD_INTENT_NOTE, LEAD_SYSTEM_NOTE, leadRequestPlan, MSG, type Msg, optimizeContext, type Result, shapeContext, specEstimate, type SwitchConfig, type SwitchState, TEST_FILE } from "./switch-core.ts";

/** Test files under cwd (skips node_modules, dot dirs, dist). */
export function hasTestFiles(dir: string, depth = 5): boolean {
	if (depth < 0) return false;
	let ents: import("node:fs").Dirent[];
	try {
		ents = readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const e of ents) {
		if (e.isFile() && TEST_FILE.test(e.name)) return true;
		if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && e.name !== "dist" && hasTestFiles(join(dir, e.name), depth - 1)) return true;
	}
	return false;
}

const ENV_ON = new Set(["1", "on", "true", "yes"]);
const ENV_OFF = new Set(["0", "off", "false", "no"]);

/** `1`/`on`/`true`/`yes` → true, `0`/`off`/`false`/`no` → false, otherwise undefined. */
export function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean | undefined {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return undefined;
	const v = raw.trim().toLowerCase();
	if (ENV_ON.has(v)) return true;
	if (ENV_OFF.has(v)) return false;
	return undefined;
}

const USER_ONLY_SWITCH = ["lead", "helper", "cacheKeepaliveMs", "cacheKeepaliveCostUsd", "cacheKeepaliveMax", "budgetUsd", "helperCostFactor", "reserveUsd", "endgameUsd", "fsGuardMaxRevert"] as const;
const USER_ONLY_JEV = ["model", "fallbackModel", "endpoint", "url", "baseUrl"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeSpec(base: SwitchConfig["spec"], over: unknown): SwitchConfig["spec"] {
	if (!isRecord(over)) return { ...base, gate: { ...base.gate }, adapt: { ...base.adapt } };
	const gate = isRecord(over.gate) ? over.gate : {};
	const adapt = isRecord(over.adapt) ? over.adapt : {};
	const rest = { ...over };
	delete rest.gate;
	delete rest.adapt;
	return { ...base, ...(rest as Partial<SwitchConfig["spec"]>), gate: { ...base.gate, ...(gate as Partial<SwitchConfig["spec"]["gate"]>) }, adapt: { ...base.adapt, ...(adapt as Partial<SwitchConfig["spec"]["adapt"]>) } };
}

function mergeJev(base: SwitchConfig["jev"], over: unknown): SwitchConfig["jev"] {
	if (!isRecord(over)) return { ...base, thr: { ...base.thr } };
	const thr = isRecord(over.thr) ? over.thr : {};
	const rest = { ...over };
	delete rest.thr;
	return { ...base, ...(rest as Partial<SwitchConfig["jev"]>), thr: { ...base.thr, ...(thr as Partial<SwitchConfig["jev"]["thr"]>) } };
}

function mergeSwitch(base: SwitchConfig, over: Record<string, unknown> | undefined): SwitchConfig {
	if (!over) return base;
	const rest = { ...over };
	const jevOver = rest.jev;
	const specOver = rest.spec;
	delete rest.jev;
	delete rest.spec;
	const next: SwitchConfig = { ...base, ...(rest as Partial<SwitchConfig>) };
	next.jev = mergeJev(base.jev, jevOver);
	next.spec = mergeSpec(base.spec, specOver);
	return next;
}

function readSwitchFile(path: string, warn: (m: string) => void): { sw?: Record<string, unknown>; journalDir?: string } {
	if (!existsSync(path)) return {};
	try {
		const j = JSON.parse(readFileSync(path, "utf8")) as { switch?: unknown; journalDir?: unknown };
		return { sw: isRecord(j.switch) ? j.switch : undefined, journalDir: typeof j.journalDir === "string" ? j.journalDir : undefined };
	} catch (e) {
		warn(`baton: cannot parse ${path}: ${(e as Error).message}`);
		return {};
	}
}

function stripProjectSwitch(sw: Record<string, unknown>, warn: (m: string) => void): Record<string, unknown> {
	const out = { ...sw };
	const where = join(agentDir(), "baton.json");
	for (const k of USER_ONLY_SWITCH) {
		if (k in out) {
			warn(`baton: ignoring project switch.${k} (set it in ${where} or the environment)`);
			delete out[k];
		}
	}
	if (isRecord(out.jev)) {
		const jev = { ...out.jev };
		for (const k of USER_ONLY_JEV) {
			if (k in jev) {
				warn(`baton: ignoring project switch.jev.${k} (set it in ${where} or the environment)`);
				delete jev[k];
			}
		}
		out.jev = jev;
	}
	return out;
}

export function journalInsideCwd(cwd: string, journalDir: string): boolean {
	const abs = resolve(cwd, journalDir);
	const rel = relative(resolve(cwd), abs);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Replay body: the lead payload plus stream and max_tokens 1. Thinking params stay so the cached prefix still matches. */
export function keepaliveBody(payload: unknown): Record<string, unknown> {
	const base = payload && typeof payload === "object" ? { ...(payload as Record<string, unknown>) } : {};
	delete base.max_completion_tokens;
	return { ...base, stream: true, max_tokens: 1 };
}

export interface CommandGroupResult {
	status: number | null;
	stdout: string;
	error?: string;
	timedOut: boolean;
}

function killProcessGroup(child: ChildProcess): void {
	const pid = child.pid;
	if (!pid) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			/* already exited */
		}
	}
}

/** Run a shell command in its own process group and kill that group on timeout. */
export function runCommandGroup(command: string, cwd: string, timeoutMs: number): Promise<CommandGroupResult> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", command], { cwd, detached: true, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		const append = (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (stdout.length > 2_500_000) stdout = stdout.slice(-2_000_000);
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		let settled = false;
		const finish = (status: number | null, error?: string, timedOut = false) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ status, stdout, error, timedOut });
		};
		const timer = setTimeout(() => {
			killProcessGroup(child);
			finish(null, "timeout", true);
		}, timeoutMs);
		child.on("error", (err) => finish(null, err.message));
		child.on("close", (status) => finish(status, status === 0 ? undefined : `exit ${status}`));
	});
}

/** Typecheck script, or `npx --no-install tsc` when a tsconfig exists, then the test script. */
export function projectCheckCommands(cwd: string): string[] | undefined {
	let pkg: { scripts?: Record<string, string> } = {};
	try {
		pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
	const sc = pkg.scripts ?? {};
	const cmds: string[] = [];
	if (sc.typecheck) cmds.push("npm run -s typecheck");
	else if (existsSync(join(cwd, "tsconfig.json"))) cmds.push("npx --no-install tsc --noEmit");
	if (sc.test && !/no test specified/.test(sc.test)) cmds.push("npm test --silent");
	return cmds.length ? cmds : undefined;
}

/** Project checks after an implement stretch. Each command has its own process group, killed on timeout. */
export async function runChecks(cwd: string, log?: (k: string, d: Record<string, unknown>) => void, timeoutMs = 120_000): Promise<{ ok: boolean; text: string } | undefined> {
	const cmds = projectCheckCommands(cwd);
	if (!cmds) return undefined;
	let ok = true;
	const out: string[] = [];
	const t0 = Date.now();
	for (const cmd of cmds) {
		const r = await runCommandGroup(`${cmd} 2>&1`, cwd, timeoutMs);
		const pass = r.status === 0 && !r.timedOut;
		ok &&= pass;
		const why = pass ? "PASS" : r.timedOut ? "ERROR timeout" : r.error ? `ERROR ${r.error}` : `FAIL (exit ${r.status})`;
		out.push(`$ ${cmd} → ${why}\n${r.stdout.slice(-2500)}`);
	}
	log?.("auto_check", { ok, cmds, ms: Date.now() - t0 });
	return { ok, text: out.join("\n") };
}

export function loadSwitchConfig(cwd: string, warn: (m: string) => void = () => {}): SwitchConfig & { journalDir: string } {
	const userPath = join(agentDir(), "baton.json");
	const user = readSwitchFile(userPath, warn);
	const project = readSwitchFile(join(cwd, ".pi", "baton.json"), warn);
	if (project.journalDir !== undefined) warn(`baton: ignoring project journalDir (set it in ${userPath} or BATON_JOURNAL_DIR)`);
	let cfg = mergeSwitch(DEFAULT_SWITCH, user.sw);
	cfg = mergeSwitch(cfg, project.sw ? stripProjectSwitch(project.sw, warn) : undefined);
	const env = process.env;
	if (env.BATON_LEAD) cfg.lead = env.BATON_LEAD;
	if (env.BATON_HELPER) cfg.helper = env.BATON_HELPER;
	const budgetRaw = env.BATON_BUDGET_USD;
	if (budgetRaw !== undefined && budgetRaw.trim() !== "") {
		const n = Number(budgetRaw);
		if (Number.isFinite(n) && n > 0) cfg.budgetUsd = n;
		else if (!Number.isFinite(n)) warn(`baton: BATON_BUDGET_USD=${budgetRaw} is not a number; ignoring it`);
	}
	const jevFlag = envFlag("BATON_JEV", env);
	if (jevFlag === false) cfg.jev.enabled = false;
	else if (jevFlag === true) cfg.jev.enabled = true;
	if (env.BATON_JEV_MODEL) cfg.jev.model = env.BATON_JEV_MODEL;
	if (env.BATON_JEV_FALLBACK_MODEL) cfg.jev.fallbackModel = env.BATON_JEV_FALLBACK_MODEL;
	const be = env.BATON_EDIT;
	if (be === "intent") cfg = { ...cfg, editTool: false, editIntents: true };
	else if (be === "off" || envFlag("BATON_EDIT", env) === false) cfg = { ...cfg, editTool: false, editIntents: false };
	else if (be === "tool" || envFlag("BATON_EDIT", env) === true) cfg = { ...cfg, editTool: true };
	const specFlag = envFlag("BATON_SPEC", env);
	if (specFlag === true) cfg.spec = mergeSpec(cfg.spec, { enabled: true });
	else if (specFlag === false) cfg.spec = mergeSpec(cfg.spec, { enabled: false });
	{
		const all = envFlag("BATON_SPEC_V2", env) === true;
		const on = (k: string) => all || envFlag(k, env) === true;
		let spec = cfg.spec;
		if (on("BATON_SPEC_GATE")) spec = mergeSpec(spec, { gate: { on: true } });
		if (on("BATON_SPEC_STOPS")) spec = mergeSpec(spec, { freeStops: true });
		if (on("BATON_SPEC_EST")) spec = mergeSpec(spec, { estimate: true });
		if (on("BATON_SPEC_PHASE")) spec = mergeSpec(spec, { phase: true });
		if (on("BATON_SPEC_ADAPT")) spec = mergeSpec(spec, { adapt: { on: true } });
		cfg.spec = spec;
	}
	const readFlag = envFlag("BATON_READ", env);
	if (readFlag === false) cfg = { ...cfg, readTool: false };
	else if (readFlag === true) cfg = { ...cfg, readTool: true };
	let journalDir = env.BATON_JOURNAL_DIR || user.journalDir || ".pi/baton";
	if (!journalInsideCwd(cwd, journalDir)) {
		warn(`baton: journalDir ${journalDir} is outside the working directory; using .pi/baton`);
		journalDir = ".pi/baton";
	}
	return { ...cfg, journalDir };
}

type Block = { type: string; id?: string; name?: string; arguments?: Record<string, unknown>; text?: string; thinking?: string };
const num = (rows: Record<string, CostRow>) => Object.values(rows).reduce((a, r) => a + r.cost, 0);

export default function batonSwitch(pi: ExtensionAPI) {
	let cfg: (SwitchConfig & { journalDir: string }) | undefined;
	let st: SwitchState | undefined;
	let costs: Record<string, CostRow> = {};
	let dir = "";
	let turn = 0;
	let started = 0;
	let prevLeadLen = 0;
	let afterHelper = false;
	let budgetStopped = false;
	let agentRunning = false;
	let keepalivePings = 0;
	let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
	let cwd = "";
	const pending = new Map<string, { pre: Snap; helper: boolean; phase: SwitchState["phase"]; name: string; command: string }>();
	const guardMs: number[] = [];

	const leadId = () => parseModelRef(cfg!.lead)!.id;
	const log = (kind: string, data: Record<string, unknown>) => {
		try {
			mkdirSync(dir, { recursive: true });
			appendFileSync(join(dir, "switch.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), kind, turn, ...data })}\n`);
		} catch {
			/* journal is best effort */
		}
	};
	const jevSummary = () =>
		st && { enabled: cfg!.jev.enabled, model: cfg!.jev.model, fallbackModel: cfg!.jev.fallbackModel, jevCalls: st.jev.calls, jevGateCalls: st.jev.gateCalls, jevTurnCalls: st.jev.turnCalls, jevFallbacks: st.jev.fallbacks, jevFallbackModel: st.jev.fallbackModel, jevCached: st.jev.cached, jevBlocks: st.jev.blocks, jevHandoffs: st.jev.handoffs, jevSwitches: st.jev.switches, jevCost: st.jev.cost, jevAvgLatMs: st.jev.calls + st.jev.fallbacks ? Math.round(st.jev.latMs / (st.jev.calls + st.jev.fallbacks)) : 0, jevMaxLatMs: Math.round(st.jev.maxLatMs), summaryCalls: st.jev.summaryCalls, summaryCost: st.jev.summaryCost, summaryText: st.track.text };
	let keepaliveCost = 0;
	const extraCost = () => (st ? st.jev.cost + st.jev.summaryCost : 0) + keepaliveCost;
	/** Ask Jev; updates stats and journals one `jev` event. Undefined = fall back to the deterministic rules. */
	const askJev = async (point: "call" | "turn", questions: JevQuestions, proposed: { model: string; call: string }, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<JevResult | undefined> => {
		if (!st || !cfg?.jev.enabled || budgetStopped) return undefined;
		const j = cfg.jev;
		const sum = buildSummary(st.track, { activeModel: isHelper(st.phase) ? cfg.helper : cfg.lead, phase: st.phase, redSame: st.red.same, redTotal: st.red.total, checksRed: !st.lastVerifyGreen && st.red.total > 0, guardFlags: st.stretchFlags.map((f) => f.why) });
		const state = buildState(st.track, sum, proposed, j);
		const r = await decide(state, questions, { model: j.model, fallbackModel: j.fallbackModel, timeoutMs: j.timeoutMs, signal });
		st.jev.latMs += r.latMs;
		st.jev.maxLatMs = Math.max(st.jev.maxLatMs, r.latMs);
		if (!r.ok) {
			st.jev.fallbacks++;
			st.jev.cost += r.cost;
			log("jev", { point, phase: st.phase, fallback: true, error: r.error.slice(0, 300), lat: Math.round(r.latMs), cost: r.cost, ...extra });
			log("jev_fallback", { point, phase: st.phase, error: r.error.slice(0, 300) });
			return undefined;
		}
		st.jev.calls++;
		if (point === "call") st.jev.gateCalls++;
		else st.jev.turnCalls++;
		if (r.cached) st.jev.cached++;
		if (r.attempt === "fallback") st.jev.fallbackModel++;
		st.jev.cost += r.usage.cost ?? 0;
		return r;
	};
	let summaryInflight = false;
	const sessionEstimate = () => budgetSpend(costs, leadId(), cfg!.helperCostFactor).estimate + extraCost();
	const overBudget = () => !!cfg && cfg.budgetUsd > 0 && sessionEstimate() + cfg.reserveUsd >= cfg.budgetUsd;
	const noticeBudget = (ctx: ExtensionContext, recheck: boolean) => {
		const estimate = cfg ? sessionEstimate() : 0;
		budgetStopped = true;
		log("budget_stop", { estimate, budget: cfg?.budgetUsd, reserve: cfg?.reserveUsd, factor: cfg?.helperCostFactor, phase: st?.phase, recheck });
		summary();
		if (ctx.hasUI) ctx.ui.notify(`Baton budget stop: session spend is about $${estimate.toFixed(2)} (budget $${cfg?.budgetUsd}, reserve $${cfg?.reserveUsd}). This prompt was not continued.`, "warning");
		ctx.abort();
	};
	const refreshSummaryText = () => {
		if (budgetStopped || !st || !cfg?.jev.enabled || !cfg.jev.summaryEveryTurns || summaryInflight) return;
		if (turn - st.track.textTurn < cfg.jev.summaryEveryTurns || st.track.toolCalls < 3) return;
		summaryInflight = true;
		const s0 = st;
		s0.track.textTurn = turn;
		const sum = buildSummary(s0.track, { activeModel: isHelper(s0.phase) ? cfg.helper : cfg.lead, phase: s0.phase, redSame: s0.red.same, redTotal: s0.red.total, checksRed: !s0.lastVerifyGreen && s0.red.total > 0, guardFlags: s0.stretchFlags.map((f) => f.why) });
		const t0 = Date.now();
		openRouterComplete({ model: openRouterModelId(cfg.helper), maxTokens: 1200, cache: false, extra: { reasoning: { effort: "low" } } }, { signal: AbortSignal.timeout(30_000) })([{ role: "user", content: summaryPrompt(s0.track, sum, cfg.jev.summaryChars) }])
			.then((r) => {
				const cost = (r.usage as { cost?: number } | undefined)?.cost ?? 0;
				s0.jev.summaryCalls++;
				s0.jev.summaryCost += cost;
				const text = r.text.replace(/\s+/g, " ").trim().slice(0, cfg!.jev.summaryChars);
				if (text) s0.track.text = text;
				log("jev_summary", { ok: !!text, chars: text.length, cost, lat: Date.now() - t0, error: r.errorMessage });
			})
			.finally(() => {
				summaryInflight = false;
			});
	};
	const summary = () => {
		if (!st) return;
		const s = { phase: st.phase, jev: jevSummary(), switches: st.switches.length, followups: st.followups, costs, total: num(costs), budget: { ...budgetSpend(costs, leadId(), cfg!.helperCostFactor), jevUsd: extraCost() }, budgetStopped, metrics: st.metrics, flags: st.flags, wallS: Math.round((Date.now() - started) / 1000), switchLog: st.switches, spec: { stats: st.specStats, runs: st.specLog, adapt: st.specAdaptLog, cap: st.specCap } };
		try {
			writeFileSync(join(dir, "switch-summary.json"), JSON.stringify(s, null, 2));
		} catch {
			/* best effort */
		}
	};

	const init = (ctx: ExtensionContext) => {
		if (cfg) return;
		const warn = (m: string) => {
			if (ctx.hasUI) ctx.ui.notify(m, "warning");
			else console.warn(m);
		};
		cfg = loadSwitchConfig(ctx.cwd, warn);
		cwd = ctx.cwd;
		dir = isAbsolute(cfg.journalDir) ? cfg.journalDir : join(ctx.cwd, cfg.journalDir);
	};

	const setModelFor = async (ctx: ExtensionContext, phase: SwitchState["phase"]) => {
		const ref = parseModelRef(isHelper(phase) ? cfg!.helper : cfg!.lead);
		const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
		if (!model) {
			log("error", { message: `model not found: ${isHelper(phase) ? cfg!.helper : cfg!.lead}` });
			return;
		}
		if (ctx.model?.id === model.id && ctx.model?.provider === model.provider) return;
		await pi.setModel(model);
	};

	pi.on("session_start", (_e, ctx) => init(ctx));
	pi.on("turn_start", (e) => {
		turn = e.turnIndex;
	});

	pi.on("before_agent_start", async (e, ctx) => {
		init(ctx);
		if (budgetStopped || overBudget()) {
			noticeBudget(ctx, budgetStopped);
			agentRunning = false;
			return undefined;
		}
		agentRunning = true;
		keepalivePings = 0;
		if (e.messageType !== "user") return undefined;
		started = Date.now();
		st = initialSwitchState(Date.now());
		st.track.task = String((e as { prompt?: string }).prompt ?? "").slice(0, 400);
		log("start", { lead: cfg!.lead, helper: cfg!.helper, config: { ...cfg } });
		if (cfg!.spec.enabled) {
			st.phase = "lead";
			await setModelFor(ctx, "lead");
			log("switch", { from: "-", to: "lead", reason: "speculative mode: the lead works, the helper continues speculatively" });
			return undefined;
		}
		if (process.env.BATON_SWITCH_START === "lead") {
			// resume (`pi -c`): the context already holds the earlier work — the lead continues directly
			st.phase = "lead";
			await setModelFor(ctx, "lead");
			log("switch", { from: "-", to: "lead", reason: "resume: BATON_SWITCH_START=lead" });
			return { systemPrompt: e.systemPrompt + LEAD_SYSTEM_NOTE + (cfg!.editTool || cfg!.readTool ? LEAD_EDIT_TOOL_NOTE : cfg!.editIntents ? LEAD_INTENT_NOTE : "") };
		}
		await setModelFor(ctx, "read");
		log("switch", { from: "-", to: "read", reason: "session start: helper reads first" });
		return { message: { customType: "baton-switch-helper", content: MSG.read, display: true }, systemPrompt: e.systemPrompt + LEAD_SYSTEM_NOTE + (cfg!.editTool || cfg!.readTool ? LEAD_EDIT_TOOL_NOTE : cfg!.editIntents ? LEAD_INTENT_NOTE : "") };
	});

	pi.on("tool_call", async (e, ctx) => {
		if (!st) return undefined;
		const c: Call = { id: e.toolCallId, name: e.toolName, args: (e.input ?? {}) as Record<string, unknown> };
		const abs = (p: string) => (isAbsolute(p) ? p : join(ctx.cwd, p));
		const g = gateCall(st, c, (p) => existsSync(abs(p)), (p) => {
			try {
				return readFileSync(abs(p), "utf8");
			} catch {
				return undefined;
			}
		});
		if (g) {
			st.blocked.push(c.id);
			log(g.reason.startsWith("Baton guardrail") ? "guardrail" : "blocked", { phase: st.phase, tool: c.name, reason: g.reason, args: JSON.stringify(c.args).slice(0, 300) });
			return g;
		}
		// 0.9: Jev gates every helper call (after the deterministic rules; errors/timeouts → rules only)
		if (isHelper(st.phase) && st.phase !== "spec" && cfg!.jev.gateCalls) {
			const phase = st.phase;
			const r = await askJev("call", CALL_QUESTIONS, { model: cfg!.helper, call: callSummary(c) }, {}, ctx.signal);
			if (r && st.phase === phase) {
				const d = gateFromAnswers(r.answers, cfg!.jev.thr);
				const ph = r.answers.phase?.type === "choice" ? r.answers.phase.choice : undefined;
				log("jev", { point: "call", phase, tool: c.name, action: d.action, reason: d.reason, probs: d.probs, jevPhase: ph, lat: Math.round(r.latMs), cost: r.usage.cost ?? 0, model: r.model, cached: r.cached, fallback: false, fallbackModel: r.attempt === "fallback" });
				const jb = applyJevGate(st, c, d);
				if (jb) {
					st.blocked.push(c.id);
					log("blocked", { phase, tool: c.name, reason: jb.reason, by: "jev", args: JSON.stringify(c.args).slice(0, 300) });
					return jb;
				}
			}
		}
		// fs guard: snapshot before every helper call that can change files, and before lead bash calls (read-like detection)
		const helper = isHelper(st.phase);
		const mayWrite = !["read", "grep", "find", "ls", "glob"].includes(c.name);
		if (mayWrite && (helper || c.name === "bash") && st.phase !== "spec" && !cfg!.spec.enabled) {
			const reading = st.phase === "read" || st.phase === "followup";
			pending.set(c.id, { pre: snapshot(ctx.cwd, { contents: helper && reading }), helper, phase: st.phase, name: c.name, command: typeof c.args.command === "string" ? c.args.command : "" });
		}
		return undefined;
	});

	pi.on("tool_result", (e, ctx) => {
		if (st && !e.parentToolCallId && !st.blocked.includes(e.toolCallId)) {
			const text = (e.content as Block[]).flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
			recordCall(st.track, { id: e.toolCallId, name: e.toolName, args: (e.input ?? {}) as Record<string, unknown> }, isHelper(st.phase) ? cfg!.helper : cfg!.lead, { isError: !!e.isError, text }, cfg!.jev.recentCalls, !isHelper(st.phase));
		}
		const p = pending.get(e.toolCallId);
		if (!p || !st) return undefined;
		pending.delete(e.toolCallId);
		const post = snapshot(ctx.cwd);
		const ms = p.pre.ms + post.ms;
		guardMs.push(ms);
		if (!p.pre.ok || !post.ok) {
			const reading = p.phase === "read" || p.phase === "followup";
			if (p.helper && reading) {
				st.wantLead = "fs guard snapshot failed";
				st.stretchGuard.push("fs guard snapshot failed (git error); working tree changes were NOT reverted");
			}
			log("fs_guard", { phase: p.phase, tool: p.name, ms: Math.round(ms * 10) / 10, snapshotOk: false, preOk: p.pre.ok, postOk: post.ok });
			return undefined;
		}
		const d = diffSnaps(p.pre, post);
		const changed = d.changed.length > 0 || d.headChanged || d.nodeModulesChanged;
		if (d.nodeModulesChanged && !(p.command && /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b/.test(p.command))) st.track.nodeModulesChanged = true;
		if (!changed) {
			if (!p.helper && p.name === "bash") st.noChange.push(e.toolCallId);
			log("fs_guard", { phase: p.phase, tool: p.name, ms: Math.round(ms * 10) / 10, changed: false });
			return undefined;
		}
		const segs = p.command ? executedSegments(p.command) : [];
		const cls = classifyEffects(d, segs);
		const reading = p.phase === "read" || p.phase === "followup";
		let reverted: ReturnType<typeof revertTo> | undefined;
		if (p.helper && reading) {
			if (cls.install) st.stretchGuard.push(`package install recorded, NOT reverted: \`${p.command.slice(0, 160)}\`${cls.keep.length ? ` (changed: ${cls.keep.join(", ")})` : ""}`);
			const cap = cfg!.fsGuardMaxRevert;
			if (d.headChanged) {
				/* HEAD moved: classifyEffects records it; files stay as they are */
			} else if (cap > 0 && cls.revert.length > cap) {
				st.stretchGuard.push(`fs guard refused to revert ${cls.revert.length} paths (cap ${cap}); NOT reverted`);
			} else if (cap === 0 && cls.revert.length) {
				st.stretchGuard.push(`fs guard revert is disabled (fsGuardMaxRevert 0); NOT reverted`);
			} else if (cls.revert.length) {
				reverted = revertTo(ctx.cwd, p.pre, cls.revert, join(dir, "fsguard", `${Date.now()}-${e.toolCallId.replace(/[^\w-]/g, "_")}`), cap);
				if (reverted.aborted) st.stretchGuard.push(`fs guard did NOT revert: ${reverted.abortReason}`);
				else {
					st.dropped.push(e.toolCallId);
					const skipped = reverted.skipped.length ? `; skipped (symlink or directory): ${[...new Set(reverted.skipped)].join(", ")}` : "";
					st.stretchGuard.push(
						`the helper's ${p.name} call${p.command ? ` \`${p.command.slice(0, 160)}\`` : ""} changed files during reading; reverted and removed from history: ${[...reverted.restored, ...reverted.removed].join(", ") || "-"}${reverted.failed.length ? `; could NOT revert: ${reverted.failed.join(", ")}` : ""}${skipped} (backup: ${reverted.backupDir})`,
					);
				}
			}
			if (cls.nonIdempotent.length) st.stretchGuard.push(`non-revertible effects, NOT reverted — you decide: ${cls.nonIdempotent.join("; ")}${cls.keep.length && !cls.install ? ` (changed: ${cls.keep.join(", ")})` : ""}`);
			else if (cls.keep.length && !cls.install) st.stretchGuard.push(`changed and NOT reverted (package manifest / lockfile): ${cls.keep.join(", ")}`);
			if (cls.revert.length || cls.nonIdempotent.length || (cls.keep.length && !cls.install)) st.wantLead = "helper changed the working tree during reading (fs guard)";
		}
		log("fs_guard", { phase: p.phase, tool: p.name, ms: Math.round(ms * 10) / 10, changed: true, files: d.changed.slice(0, 30), headChanged: d.headChanged, nodeModulesChanged: d.nodeModulesChanged, install: cls.install, nonIdempotent: cls.nonIdempotent, reverted, kept: cls.keep });
		return undefined;
	});

	pi.on("message_end", (e, ctx) => {
		const m = e.message as { role?: string; model?: string; usage?: Parameters<typeof addCost>[2]; responseId?: string; stopReason?: string };
		if (m.role !== "assistant") return undefined;
		costs = addCost(costs, m.model ?? "?", m.usage);
		const isLead = !!cfg && isLeadModel(m.model, cfg.lead);
		log("usage", { model: m.model, phase: st?.phase, responseId: m.responseId, stopReason: m.stopReason, cost: m.usage?.cost?.total ?? 0, input: m.usage?.input, output: m.usage?.output, cacheRead: m.usage?.cacheRead, cacheWrite: m.usage?.cacheWrite });
		if (isLead && afterHelper) {
			log("lead_after_helper", { cacheRead: m.usage?.cacheRead, cacheWrite: m.usage?.cacheWrite, input: m.usage?.input, cost: m.usage?.cost?.total ?? 0 });
			afterHelper = false;
		}
		if (cfg && st && (budgetStopped || overBudget())) noticeBudget(ctx, budgetStopped);
		return undefined;
	});

	// Keep the lead prompt cache warm during a helper stretch. max_tokens is outside the cached
	// prefix; thinking params are copied unchanged (changing them misses the cache).
	let lastLeadPayload: unknown = null;
	let lastLeadAt = 0;
	let keepaliveBusy = false;
	const keepaliveTick = async () => {
		if (!agentRunning || !st || !cfg || !isHelper(st.phase) || !lastLeadPayload || keepaliveBusy || budgetStopped) return;
		if (parseModelRef(cfg.lead)?.provider !== "openrouter") return;
		if (!cfg.cacheKeepaliveMs || Date.now() - lastLeadAt < cfg.cacheKeepaliveMs) return;
		if (keepalivePings >= cfg.cacheKeepaliveMax) return;
		const nextCost = cfg.cacheKeepaliveCostUsd;
		if (cfg.budgetUsd > 0 && sessionEstimate() + nextCost + cfg.reserveUsd >= cfg.budgetUsd) return;
		const key = process.env.OPENROUTER_API_KEY;
		if (!key) return;
		keepaliveBusy = true;
		const t0 = Date.now();
		try {
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), 30_000);
			const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
				body: JSON.stringify(keepaliveBody(lastLeadPayload)),
				signal: ac.signal,
			});
			let firstMs: number | null = null;
			try {
				const rd = r.body?.getReader();
				if (rd) {
					// skip OpenRouter's ": PROCESSING" comments: wait for the first model chunk,
					// so the upstream request has really read the cached prefix before we abort
					const dec = new TextDecoder();
					for (;;) {
						const { done, value } = await rd.read();
						if (done || dec.decode(value, { stream: true }).includes('"choices"')) break;
					}
					firstMs = Date.now() - t0;
					await rd.cancel().catch(() => {});
				}
			} finally {
				ac.abort();
				clearTimeout(timer);
			}
			const counted = r.ok;
			if (counted) {
				keepaliveCost += nextCost;
				keepalivePings++;
			}
			lastLeadAt = t0;
			log("cache_keepalive", { status: r.status, ms: Date.now() - t0, firstMs, costEstimate: counted ? nextCost : 0, counted, phase: st.phase, pings: keepalivePings });
		} catch (err) {
			log("cache_keepalive", { error: String((err as Error).name), phase: st?.phase, counted: false });
			lastLeadAt = Date.now();
		} finally {
			keepaliveBusy = false;
		}
	};
	keepaliveTimer = setInterval(() => void keepaliveTick(), 10_000);
	keepaliveTimer.unref?.();

	pi.on("context", (e, _ctx) => {
		if (!st || !cfg) return undefined;
		const forLead = !isHelper(st.phase);
		const msgs = shapeContext(e.messages as unknown as Msg[], st, forLead, cfg.lead);
		return { messages: msgs as unknown as typeof e.messages };
	});

	pi.on("before_provider_request", (e) => {
		if (!st || !cfg || isHelper(st.phase)) return undefined;
		const p = e.payload as { model?: string } | undefined;
		if (!p?.model || !isLeadModel(String(p.model), cfg.lead)) return undefined;
		const plan = leadRequestPlan(st, cfg!);
		let out = capMaxTokens(e.payload, plan.maxTokens);
		const len = Array.isArray((p as { messages?: unknown[] }).messages) ? (p as { messages: unknown[] }).messages.length : 0;
		if (prevLeadLen && len - prevLeadLen > 3) {
			const a = anchorCache(out, prevLeadLen);
			out = a.payload;
			log("cache_anchor", { prevLen: prevLeadLen, len, anchored: a.anchored, at: a.at, partType: a.partType, before: a.before, after: a.after, skipped: a.skipped });
		}
		prevLeadLen = len;
		if (plan.capReasoning) out = capReasoning(out, cfg!.thinkingCap);
		lastLeadPayload = out;
		lastLeadAt = Date.now();
		const o = out as { reasoning?: unknown; reasoning_effort?: unknown; max_tokens?: unknown; max_completion_tokens?: unknown };
		log("lead_request", { phase: st.phase, planning: plan.planning, reasoning: o.reasoning ?? null, reasoning_effort: o.reasoning_effort ?? null, max_tokens: o.max_tokens ?? o.max_completion_tokens ?? null, cacheControls: countCacheControl(out), messages: len });
		return out;
	});

	pi.on("turn_end", async (e, ctx) => {
		pending.clear();
		if (budgetStopped) return undefined;
		if (!st || st.phase === "done") return undefined;
		const m = e.message as { role?: string; content?: Block[]; model?: string; stopReason?: string; errorMessage?: string };
		if (m.stopReason === "error" || m.stopReason === "aborted") {
			agentRunning = false;
			log("model_error", { phase: st.phase, model: m.model, stopReason: m.stopReason, error: String(m.errorMessage ?? "").slice(0, 300) });
			return undefined;
		}
		const blocks = Array.isArray(m.content) ? m.content : [];
		const calls: Call[] = blocks.filter((b) => b.type === "toolCall").map((b) => ({ id: b.id!, name: b.name!, args: b.arguments ?? {} }));
		const text = blocks.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
		const hasThinking = blocks.some((b) => b.type === "thinking" && b.thinking?.trim());
		const results: Result[] = e.toolResults.map((r) => ({
			id: r.toolCallId,
			isError: !!r.isError,
			text: (r.content as Block[]).flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n").slice(0, 20_000),
		}));
		const from = st.phase;
		const diffStat = () => {
			try {
				return execSync("git diff --stat HEAD; git ls-files --others --exclude-standard | sed 's/^/new file: /'", { cwd: ctx.cwd, encoding: "utf8", timeout: 10_000 }).slice(-3000);
			} catch {
				return "";
			}
		};
		// 0.9: Jev at the turn boundary (lead: routine ahead → helper; helper debug/review: stuck → lead)
		let jev: TurnJev | undefined;
		const realCalls = calls.filter((c) => !st!.blocked.includes(c.id) && !st!.dropped.includes(c.id));
		if (cfg!.jev.gateTurns && !cfg!.spec.enabled && realCalls.length && !st.wantLead && (from === "lead" || from === "debug" || from === "review")) {
			const last = realCalls[realCalls.length - 1]!;
			const r = await askJev("turn", TURN_QUESTIONS, { model: isHelper(from) ? cfg!.helper : cfg!.lead, call: `(turn boundary — last call of the turn) ${callSummary(last)}` }, {}, ctx.signal);
			if (r) {
				jev = turnJevFromAnswers(r.answers);
				log("jev", { point: "turn", phase: from, probs: jev, consecutiveNonWrite: st.track.consecutiveNonWrite, lat: Math.round(r.latMs), cost: r.usage.cost ?? 0, model: r.model, cached: r.cached, fallback: false, fallbackModel: r.attempt === "fallback" });
			}
		}
		let specP: number | undefined;
		let specEst: number | undefined;
		if (cfg!.spec.enabled && from === "lead" && realCalls.length && cfg!.jev.enabled) {
			const last = realCalls[realCalls.length - 1]!;
			const qs = cfg!.spec.estimate && (st.specCooldown ?? 0) === 0 ? { ...SPEC_QUESTIONS, ...SPEC_EST_QUESTIONS } : SPEC_QUESTIONS;
			const r = await askJev("turn", qs, { model: cfg!.lead, call: `(lead turn boundary — latest call) ${callSummary(last)}` }, {}, ctx.signal);
			if (r) {
				const nv = (k: string) => {
					const a = r.answers[k];
					return a?.type === "noul" ? a.noul : undefined;
				};
				specP = nv("more_calls");
				specEst = specEstimate(nv("more_3"), nv("more_6"), nv("more_10"));
				log("jev", { point: "spec", phase: from, pMore: specP, est: specEst, p3: nv("more_3"), p6: nv("more_6"), p10: nv("more_10"), cap: st.specCap, lat: Math.round(r.latMs), cost: r.usage.cost ?? 0, model: r.model, cached: r.cached, fallback: false });
			}
		}
		// 0.13.1 v1: before every speculative step after the free ones, Jev decides whether to go on
		let specCont: number | undefined;
		const run = st.specRun;
		if (cfg!.spec.enabled && cfg!.spec.gate.on && from === "spec" && run && !run.stop && realCalls.length && run.steps + 1 >= cfg!.spec.gate.free && run.steps + 1 < run.n && cfg!.jev.enabled) {
			const last = realCalls[realCalls.length - 1]!;
			const r = await askJev("turn", SPEC_CONT_QUESTIONS, { model: cfg!.helper, call: `(speculative helper step ${run.steps + 1}/${run.n}) ${callSummary(last)}` }, {}, ctx.signal);
			if (r) {
				const a = r.answers.cont;
				specCont = a?.type === "noul" ? a.noul : undefined;
				log("jev", { point: "spec_cont", phase: from, step: run.steps + 1, pCont: specCont, lat: Math.round(r.latMs), cost: r.usage.cost ?? 0, model: r.model, cached: r.cached, fallback: false });
			}
		}
		refreshSummaryText();
		const b0 = budgetSpend(costs, leadId(), cfg!.helperCostFactor);
		const budgetLeft = cfg!.budgetUsd > 0 ? cfg!.budgetUsd - cfg!.reserveUsd - b0.estimate - extraCost() : undefined;
		const diffFull = () => {
			try {
				return diffVsHead(ctx.cwd);
			} catch {
				return "";
			}
		};
		const implementMayFinish = from === "implement" && !st.wantLead && realCalls.length === 0 && !/ESCALATE/.test(text) && !(cfg!.maxImplementMs > 0 && Date.now() - st.stretchStart > cfg!.maxImplementMs) && !(cfg!.maxImplementCalls > 0 && st.stretchCalls >= cfg!.maxImplementCalls);
		const autoCheckResult = implementMayFinish ? await runChecks(ctx.cwd, log) : undefined;
		const autoCheck = () => autoCheckResult;
		const d = decideTurn(st, { turn, now: Date.now(), text, calls, results, jev, specP, specEst, specCont, budgetLeft, diffFull, autoCheck, empty: !calls.length && !text.trim() && !hasThinking, lengthStop: m.stopReason === "length", testsExist: !isHelper(from) ? hasTestFiles(ctx.cwd) : undefined, diffStat }, cfg);
		const entries: SessionBoundaryDraft[] = [];
		if (d.reason && d.to === from && d.continue) log(d.message ? "nudge" : "retry", { phase: from, reason: d.reason });
		if (d.to !== from) {
			if (isHelper(d.to)) keepalivePings = 0;
			if (isHelper(from) && !isHelper(d.to)) afterHelper = true;
			log("switch", { from, to: d.to, reason: d.reason, byJev: /^jev:|\(jev:/.test(d.reason ?? "") || /jev:/.test(d.reason ?? ""), jev: { calls: st.jev.calls, fallbacks: st.jev.fallbacks, cost: st.jev.cost }, compacted: d.compacted, report: d.report, metrics: st.metrics, model: d.to === "done" ? undefined : isHelper(d.to) ? cfg!.helper : cfg!.lead, costs });
			if (d.to !== "done") await setModelFor(ctx, d.to);
			summary();
		}
		if (d.continue && d.to === from && !d.message) entries.push({ type: "custom_message", customType: "baton-switch-lead", content: "[baton switch] The previous response was empty. Continue.", display: true });
		if (d.message) entries.push({ type: "custom_message", customType: d.message.audience === "helper" ? "baton-switch-helper" : "baton-switch-lead", content: d.message.text, display: true });
		if (!entries.length && !d.continue) return undefined;
		return { entries, continue: d.continue };
	});

	pi.on("agent_end", () => {
		agentRunning = false;
		pending.clear();
		if (guardMs.length) log("fs_guard_stats", { calls: guardMs.length, avgMs: Math.round((guardMs.reduce((a, b) => a + b, 0) / guardMs.length) * 10) / 10, maxMs: Math.round(Math.max(...guardMs) * 10) / 10 });
		if (st) log("end", { phase: st.phase, costs, metrics: st.metrics, flags: st.flags, jev: jevSummary(), budget: { ...budgetSpend(costs, leadId(), cfg!.helperCostFactor), jevUsd: extraCost() }, budgetStopped });
		summary();
	});

	pi.on("session_shutdown", () => {
		agentRunning = false;
		pending.clear();
		if (keepaliveTimer) clearInterval(keepaliveTimer);
		keepaliveTimer = undefined;
	});

	const delegateReads = async (instruction: string) => {
		const left = st ? cfg!.maxFollowups - st.followups : 0;
		return { content: [{ type: "text" as const, text: left > 0 ? `Delegated to the helper: ${instruction}` : "No delegated read rounds left — read the files yourself." }], details: { left } };
	};
	pi.registerTool({
		name: "delegate_reads",
		label: "Delegate reads",
		description: "Hand a batch of file reading / searching to the cheaper helper model (same as baton_delegate kind \"reads\"). Limited rounds.",
		parameters: Type.Object({ instruction: Type.String({ description: "What to read or search for, concretely." }) }),
		async execute(_id, params) {
			return delegateReads(params.instruction);
		},
	});
	pi.registerTool({
		name: "baton_delegate",
		label: "Baton delegate",
		description:
			"Hand work to the cheaper helper model. kind \"reads\": it reads/searches what you list and you get a harness report with the outputs verbatim (limited rounds). kind \"implement\": it writes the files of your spec (may create files); Baton then runs typecheck+tests itself, red → the helper fixes, then you get the full diff to review. kind \"debug\": it runs typecheck/tests/build and fixes failures with small edits, then hands back with a report.",
		parameters: Type.Object({ kind: Type.Union([Type.Literal("reads"), Type.Literal("implement"), Type.Literal("debug")]), instruction: Type.Optional(Type.String({ description: "What to read; for implement: the precise spec (files, exports, signatures, behaviour, tests); or extra notes for the fix loop." })) }),
		async execute(_id, params) {
			if (params.kind === "reads") return delegateReads(params.instruction ?? "");
			if (params.kind === "implement") return { content: [{ type: "text" as const, text: "The helper implements the spec now; checks run automatically and you get the diff for review." }], details: {} };
			return { content: [{ type: "text" as const, text: "The helper takes over the verify/fix loop now." }], details: {} };
		},
	});
	pi.registerTool({
		name: "baton_read",
		label: "Baton read",
		description:
			"Study code in ONE call instead of many read turns. The helper runs in this session with your full context (task, files read, decisions), so a short request is enough — no subagent brief (each of your turns resends the whole context; a cheap helper reads instead). request = free text: what to find out or read and where to look. Returns the helper's raw tool outputs verbatim in one result — deduplicated, skills in full, no helper commentary — so nothing is lost; call again for more.",
		parameters: Type.Object({ request: Type.String({ description: "What to find out / read and where to look, in your own words." }) }),
		async execute() {
			return { content: [{ type: "text" as const, text: "baton_read: the helper is reading…" }], details: {} };
		},
	});
	pi.registerTool({
		name: "baton_edit",
		label: "Baton edit",
		description:
			"Change files without typing them yourself. The helper runs in this session with your full context (task, files read, decisions), so a short request is enough — unlike a subagent that starts empty. You stay the author, the cheap helper makes the edit in this same session and runs the write → typecheck/test → fix loop. request = free text: what to change and why (files, behaviour, key names, tests). Returns one result: changed files/definitions, compressed diff, tsc/test status — or NOT DONE (then fix it yourself with write/edit).",
		parameters: Type.Object({ request: Type.String({ description: "What to change and why, in your own words (files, behaviour, important names, tests)." }) }),
		async execute() {
			// placeholder: replaced in the lead's view by the outcome when the helper hands back (st.stubs)
			return { content: [{ type: "text" as const, text: "baton_edit: the helper is making the edit…" }], details: {} };
		},
	});
	pi.registerTool({
		name: "baton_optimize",
		label: "Baton optimize",
		description: "Drop superseded read outputs from your context and clip long ones (one prompt-cache rewrite).",
		parameters: Type.Object({}),
		async execute() {
			const r = st ? optimizeContext(st) : { stubbed: 0, clipped: 0 };
			log("optimize", r);
			return { content: [{ type: "text" as const, text: `Context optimized: ${r.stubbed} stale outputs dropped, ${r.clipped} clipped.` }], details: r };
		},
	});
}

/**
 * Baton "switch" mode for pi: in-session model switching, one session, the lead model (Opus) leads.
 *   read (helper) → lead plans + writes → debug/verify (helper, escalates after N red cycles) → lead … →
 *   review (helper) → final short check (lead, optional) → done.
 * Load with `-e src/pi/switch.ts`, or `-e src/pi/index.ts` with BATON_MODE=switch.
 * Config: `.pi/baton.json` → { "switch": { …SwitchConfig } }. Journal: `<journalDir>/switch.jsonl`, summary in switch-summary.json.
 */
import { execSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { decide, type JevQuestions, type JevResult } from "../core/jev.ts";
import { openRouterComplete, openRouterModelId } from "../core/openrouter.ts";
import { parseModelRef } from "./config.ts";
import { buildState, buildSummary, CALL_QUESTIONS, callSummary, gateFromAnswers, recordCall, summaryPrompt, TURN_QUESTIONS, turnJevFromAnswers, type TurnJev } from "./jev-policy.ts";
import { classifyEffects, diffSnaps, revertTo, type Snap, snapshot } from "./fsguard.ts";
import { addCost, anchorCache, applyJevGate, budgetExceeded, budgetSpend, type Call, type CostRow, capMaxTokens, capReasoning, countCacheControl, DEFAULT_SWITCH, executedSegments, decideTurn, gateCall, initialSwitchState, isHelper, LEAD_EDIT_TOOL_NOTE, LEAD_SYSTEM_NOTE, leadRequestPlan, MSG, type Msg, optimizeContext, type Result, shapeContext, type SwitchConfig, type SwitchState, TEST_FILE } from "./switch-core.ts";

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

/**
 * 0.10: Baton runs the project's checks itself (after an implement stretch): `typecheck`/`tsc` script or `npx tsc --noEmit`
 * when a tsconfig exists, then the `test` script. 120 s each, process group killed on timeout.
 */
export function runChecks(cwd: string, log?: (k: string, d: Record<string, unknown>) => void): { ok: boolean; text: string } | undefined {
	let pkg: { scripts?: Record<string, string> } = {};
	try {
		pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
	const sc = pkg.scripts ?? {};
	const cmds: string[] = [];
	if (sc.typecheck) cmds.push("npm run -s typecheck");
	else if (existsSync(join(cwd, "tsconfig.json"))) cmds.push("npx tsc --noEmit");
	if (sc.test && !/no test specified/.test(sc.test)) cmds.push("npm test --silent");
	if (!cmds.length) return undefined;
	let ok = true;
	const out: string[] = [];
	const t0 = Date.now();
	for (const cmd of cmds) {
		const r = spawnSync("bash", ["-c", `${cmd} 2>&1`], { cwd, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 20_000_000, env: { ...process.env, CI: "1" } });
		const pass = r.status === 0;
		ok &&= pass;
		out.push(`$ ${cmd} → ${pass ? "PASS" : r.error ? `ERROR ${r.error.message}` : `FAIL (exit ${r.status})`}\n${String(r.stdout ?? "").slice(-2500)}`);
	}
	log?.("auto_check", { ok, cmds, ms: Date.now() - t0 });
	return { ok, text: out.join("\n") };
}

export function loadSwitchConfig(cwd: string): SwitchConfig & { journalDir: string } {
	let over: Partial<SwitchConfig> = {};
	let journalDir = ".pi/baton";
	for (const p of [join(cwd, ".pi", "baton.json")]) {
		if (!existsSync(p)) continue;
		try {
			const j = JSON.parse(readFileSync(p, "utf8"));
			over = { ...over, ...(j.switch ?? {}) };
			if (typeof j.journalDir === "string") journalDir = j.journalDir;
		} catch {
			/* ignore bad config */
		}
	}
	const env = process.env.BATON_BUDGET_USD;
	if (env && Number(env) > 0) over.budgetUsd = Number(env);
	const jevOver = (over.jev ?? {}) as Partial<SwitchConfig["jev"]>;
	const jev = { ...DEFAULT_SWITCH.jev, ...jevOver, thr: { ...DEFAULT_SWITCH.jev.thr, ...(jevOver.thr ?? {}) } };
	if (process.env.BATON_JEV === "0" || process.env.BATON_JEV === "off") jev.enabled = false;
	if (process.env.BATON_JEV_MODEL) jev.model = process.env.BATON_JEV_MODEL;
	// 0.12: BATON_EDIT=tool (default: baton_edit tool + intents) | intent (only <edit-intent>) | off (lead edits itself)
	const be = process.env.BATON_EDIT;
	if (be === "intent") Object.assign(over, { editTool: false, editIntents: true });
	else if (be === "off" || be === "0") Object.assign(over, { editTool: false, editIntents: false });
	else if (be === "tool") Object.assign(over, { editTool: true });
	// 0.12.1: BATON_READ=tool (default) | off
	if (process.env.BATON_READ === "off" || process.env.BATON_READ === "0") Object.assign(over, { readTool: false });
	return { ...DEFAULT_SWITCH, ...over, jev, journalDir };
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
	/** Ask Jev; updates stats and journals one `jev` event. Undefined = fall back to the 0.8.1 rules. */
	const askJev = async (point: "call" | "turn", questions: JevQuestions, proposed: { model: string; call: string }, extra: Record<string, unknown> = {}): Promise<JevResult | undefined> => {
		if (!st || !cfg?.jev.enabled) return undefined;
		const j = cfg.jev;
		const sum = buildSummary(st.track, { activeModel: isHelper(st.phase) ? cfg.helper : cfg.lead, phase: st.phase, redSame: st.red.same, redTotal: st.red.total, checksRed: !st.lastVerifyGreen && st.red.total > 0, guardFlags: st.stretchFlags.map((f) => f.why) });
		const state = buildState(st.track, sum, proposed, j);
		const r = await decide(state, questions, { model: j.model, fallbackModel: j.fallbackModel, timeoutMs: j.timeoutMs });
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
	const refreshSummaryText = () => {
		if (!st || !cfg?.jev.enabled || !cfg.jev.summaryEveryTurns || summaryInflight) return;
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
		const s = { phase: st.phase, jev: jevSummary(), switches: st.switches.length, followups: st.followups, costs, total: num(costs), budget: { ...budgetSpend(costs, leadId(), cfg!.helperCostFactor), jevUsd: extraCost() }, budgetStopped, metrics: st.metrics, flags: st.flags, wallS: Math.round((Date.now() - started) / 1000), switchLog: st.switches };
		try {
			writeFileSync(join(dir, "switch-summary.json"), JSON.stringify(s, null, 2));
		} catch {
			/* best effort */
		}
	};

	const init = (ctx: ExtensionContext) => {
		if (cfg) return;
		cfg = loadSwitchConfig(ctx.cwd);
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
		if (e.messageType !== "user") return undefined;
		started = Date.now();
		st = initialSwitchState(Date.now());
		st.track.task = String((e as { prompt?: string }).prompt ?? "").slice(0, 400);
		log("start", { lead: cfg!.lead, helper: cfg!.helper, config: { ...cfg } });
		if (process.env.BATON_SWITCH_START === "lead") {
			// resume (`pi -c`): the context already holds the earlier work — the lead continues directly
			st.phase = "lead";
			await setModelFor(ctx, "lead");
			log("switch", { from: "-", to: "lead", reason: "resume: BATON_SWITCH_START=lead" });
			return { systemPrompt: e.systemPrompt + LEAD_SYSTEM_NOTE + (cfg!.editTool ? LEAD_EDIT_TOOL_NOTE : "") };
		}
		await setModelFor(ctx, "read");
		log("switch", { from: "-", to: "read", reason: "session start: helper reads first" });
		return { message: { customType: "baton-switch-helper", content: MSG.read, display: true }, systemPrompt: e.systemPrompt + LEAD_SYSTEM_NOTE + (cfg!.editTool ? LEAD_EDIT_TOOL_NOTE : "") };
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
		if (isHelper(st.phase) && cfg!.jev.gateCalls) {
			const phase = st.phase;
			const r = await askJev("call", CALL_QUESTIONS, { model: cfg!.helper, call: callSummary(c) });
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
		if (mayWrite && (helper || c.name === "bash")) {
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
		const d = diffSnaps(p.pre, post);
		const ms = p.pre.ms + post.ms;
		guardMs.push(ms);
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
			if (cls.revert.length) {
				reverted = revertTo(ctx.cwd, p.pre, cls.revert, join(dir, "fsguard", `${Date.now()}-${e.toolCallId.replace(/[^\w-]/g, "_")}`));
				st.dropped.push(e.toolCallId);
				st.stretchGuard.push(
					`the helper's ${p.name} call${p.command ? ` \`${p.command.slice(0, 160)}\`` : ""} changed files during reading; reverted and removed from history: ${[...reverted.restored, ...reverted.removed].join(", ") || "-"}${reverted.failed.length ? `; could NOT revert: ${reverted.failed.join(", ")}` : ""} (backup: ${reverted.backupDir})`,
				);
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
		const isLead = !!m.model && String(m.model).includes(leadId());
		log("usage", { model: m.model, phase: st?.phase, responseId: m.responseId, stopReason: m.stopReason, cost: m.usage?.cost?.total ?? 0, input: m.usage?.input, output: m.usage?.output, cacheRead: m.usage?.cacheRead, cacheWrite: m.usage?.cacheWrite });
		if (isLead && afterHelper) {
			log("lead_after_helper", { cacheRead: m.usage?.cacheRead, cacheWrite: m.usage?.cacheWrite, input: m.usage?.input, cost: m.usage?.cost?.total ?? 0 });
			afterHelper = false;
		}
		if (cfg && st && !budgetStopped) {
			const b0 = budgetExceeded(costs, leadId(), cfg);
			const b = { estimate: b0.estimate + extraCost(), stop: cfg.budgetUsd > 0 && b0.estimate + extraCost() + cfg.reserveUsd >= cfg.budgetUsd };
			if (b.stop) {
				budgetStopped = true;
				log("budget_stop", { estimate: b.estimate, budget: cfg.budgetUsd, reserve: cfg.reserveUsd, factor: cfg.helperCostFactor, phase: st.phase });
				summary();
				ctx.abort();
			}
		}
		return undefined;
	});

	// 0.10.1: keep the lead's prompt cache warm during long helper stretches.
	// Replays the last lead payload byte-identically with max_tokens 1, so the
	// cached prefix is read (≈0.1× price) instead of expiring and being rewritten (1.25×).
	let lastLeadPayload: unknown = null;
	let lastLeadAt = 0;
	let keepaliveBusy = false;
	const keepaliveTick = async () => {
		if (!st || !cfg || !isHelper(st.phase) || !lastLeadPayload || keepaliveBusy || budgetStopped) return;
		if (!cfg.cacheKeepaliveMs || Date.now() - lastLeadAt < cfg.cacheKeepaliveMs) return;
		const key = process.env.OPENROUTER_API_KEY;
		if (!key) return;
		keepaliveBusy = true;
		const t0 = Date.now();
		try {
			// Byte-identical body (thinking params included — changing them invalidates Anthropic's
			// message cache, arm J: keepalive without reasoning missed and cost $0.195). Stream and
			// abort on the first chunk: the prefix is read from cache, almost no output is billed.
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort(), 30_000);
			const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
				method: "POST",
				headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
				body: JSON.stringify({ ...(lastLeadPayload as Record<string, unknown>), stream: true }),
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
			const cost = cfg.cacheKeepaliveCostUsd;
			keepaliveCost += cost;
			lastLeadAt = t0;
			log("cache_keepalive", { status: r.status, ms: Date.now() - t0, firstMs, costEstimate: cost, phase: st.phase });
		} catch (err) {
			log("cache_keepalive", { error: String((err as Error).name), phase: st?.phase });
			lastLeadAt = Date.now();
		} finally {
			keepaliveBusy = false;
		}
	};
	const keepaliveTimer = setInterval(() => void keepaliveTick(), 10_000);
	(keepaliveTimer as { unref?: () => void }).unref?.();

	pi.on("context", (e, ctx) => {
		if (!st) return undefined;
		const forLead = !isHelper(st.phase);
		const msgs = shapeContext(e.messages as unknown as Msg[], st, forLead, leadId());
		return { messages: msgs as unknown as typeof e.messages };
	});

	pi.on("before_provider_request", (e) => {
		if (!st || isHelper(st.phase)) return undefined;
		const p = e.payload as { model?: string } | undefined;
		if (!p?.model || !String(p.model).includes(leadId())) return undefined;
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
		if (!st || st.phase === "done") return undefined;
		const m = e.message as { role?: string; content?: Block[]; model?: string; stopReason?: string; errorMessage?: string };
		if (m.stopReason === "error" || m.stopReason === "aborted") {
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
		if (cfg!.jev.gateTurns && realCalls.length && !st.wantLead && (from === "lead" || from === "debug" || from === "review")) {
			const last = realCalls[realCalls.length - 1]!;
			const r = await askJev("turn", TURN_QUESTIONS, { model: isHelper(from) ? cfg!.helper : cfg!.lead, call: `(turn boundary — last call of the turn) ${callSummary(last)}` });
			if (r) {
				jev = turnJevFromAnswers(r.answers);
				log("jev", { point: "turn", phase: from, probs: jev, consecutiveNonWrite: st.track.consecutiveNonWrite, lat: Math.round(r.latMs), cost: r.usage.cost ?? 0, model: r.model, cached: r.cached, fallback: false, fallbackModel: r.attempt === "fallback" });
			}
		}
		refreshSummaryText();
		const b0 = budgetSpend(costs, leadId(), cfg!.helperCostFactor);
		const budgetLeft = cfg!.budgetUsd > 0 ? cfg!.budgetUsd - cfg!.reserveUsd - b0.estimate - extraCost() : undefined;
		const diffFull = () => {
			try {
				return execSync("git add -N . 2>/dev/null; git diff HEAD -- . ':!package-lock.json'", { cwd: ctx.cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 20_000_000 });
			} catch {
				return "";
			}
		};
		const autoCheck = () => runChecks(ctx.cwd, log);
		const d = decideTurn(st, { turn, now: Date.now(), text, calls, results, jev, budgetLeft, diffFull, autoCheck, empty: !calls.length && !text.trim() && !hasThinking, lengthStop: m.stopReason === "length", testsExist: !isHelper(from) ? hasTestFiles(ctx.cwd) : undefined, diffStat }, cfg);
		const entries: SessionBoundaryDraft[] = [];
		if (d.reason && d.to === from && d.continue) log(d.message ? "nudge" : "retry", { phase: from, reason: d.reason });
		if (d.to !== from) {
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
		if (guardMs.length) log("fs_guard_stats", { calls: guardMs.length, avgMs: Math.round((guardMs.reduce((a, b) => a + b, 0) / guardMs.length) * 10) / 10, maxMs: Math.round(Math.max(...guardMs) * 10) / 10 });
		if (st) log("end", { phase: st.phase, costs, metrics: st.metrics, flags: st.flags, jev: jevSummary(), budget: { ...budgetSpend(costs, leadId(), cfg!.helperCostFactor), jevUsd: extraCost() }, budgetStopped });
		summary();
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
			"Study code through the cheaper helper model (same session, no edits). request = free text: what to find out or read (files, APIs, where to look). The result is the helper's tool outputs verbatim, deduplicated, skills in full, without its reasoning — one tool result.",
		parameters: Type.Object({ request: Type.String({ description: "What to find out / read and where to look, in your own words." }) }),
		async execute() {
			return { content: [{ type: "text" as const, text: "baton_read: the helper is reading…" }], details: {} };
		},
	});
	pi.registerTool({
		name: "baton_edit",
		label: "Baton edit",
		description:
			"Change files through the cheaper helper model (same session, same context). request = free text: what to change and why. Baton runs typecheck+tests and the fix loop; the result lists changed files/definitions, a compressed diff and the check status, or says the helper failed (then edit yourself).",
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

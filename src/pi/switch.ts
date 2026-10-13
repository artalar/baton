/**
 * Baton "switch" mode for pi: in-session model switching, one session, the lead model (Opus) leads.
 *   read (helper) → lead plans + writes → debug/verify (helper, escalates after N red cycles) → lead … →
 *   review (helper) → final short check (lead, optional) → done.
 * Load with `-e src/pi/switch.ts`, or `-e src/pi/index.ts` with BATON_MODE=switch.
 * Config: `.pi/baton.json` → { "switch": { …SwitchConfig } }. Journal: `<journalDir>/switch.jsonl`, summary in switch-summary.json.
 */
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseModelRef } from "./config.ts";
import { classifyEffects, diffSnaps, revertTo, type Snap, snapshot } from "./fsguard.ts";
import { addCost, anchorCache, budgetExceeded, budgetSpend, type Call, type CostRow, capMaxTokens, capReasoning, countCacheControl, DEFAULT_SWITCH, executedSegments, decideTurn, gateCall, initialSwitchState, isHelper, LEAD_SYSTEM_NOTE, leadRequestPlan, MSG, type Msg, optimizeContext, type Result, shapeContext, type SwitchConfig, type SwitchState, TEST_FILE } from "./switch-core.ts";

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
	return { ...DEFAULT_SWITCH, ...over, journalDir };
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
	const summary = () => {
		if (!st) return;
		const s = { phase: st.phase, switches: st.switches.length, followups: st.followups, costs, total: num(costs), budget: budgetSpend(costs, leadId(), cfg!.helperCostFactor), budgetStopped, metrics: st.metrics, flags: st.flags, wallS: Math.round((Date.now() - started) / 1000), switchLog: st.switches };
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
		log("start", { lead: cfg!.lead, helper: cfg!.helper, config: { ...cfg } });
		if (process.env.BATON_SWITCH_START === "lead") {
			// resume (`pi -c`): the context already holds the earlier work — the lead continues directly
			st.phase = "lead";
			await setModelFor(ctx, "lead");
			log("switch", { from: "-", to: "lead", reason: "resume: BATON_SWITCH_START=lead" });
			return { systemPrompt: e.systemPrompt + LEAD_SYSTEM_NOTE };
		}
		await setModelFor(ctx, "read");
		log("switch", { from: "-", to: "read", reason: "session start: helper reads first" });
		return { message: { customType: "baton-switch-helper", content: MSG.read, display: true }, systemPrompt: e.systemPrompt + LEAD_SYSTEM_NOTE };
	});

	pi.on("tool_call", (e, ctx) => {
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
		const p = pending.get(e.toolCallId);
		if (!p || !st) return undefined;
		pending.delete(e.toolCallId);
		const post = snapshot(ctx.cwd);
		const d = diffSnaps(p.pre, post);
		const ms = p.pre.ms + post.ms;
		guardMs.push(ms);
		const changed = d.changed.length > 0 || d.headChanged || d.nodeModulesChanged;
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
			const b = budgetExceeded(costs, leadId(), cfg);
			if (b.stop) {
				budgetStopped = true;
				log("budget_stop", { estimate: b.estimate, budget: cfg.budgetUsd, reserve: cfg.reserveUsd, factor: cfg.helperCostFactor, phase: st.phase });
				summary();
				ctx.abort();
			}
		}
		return undefined;
	});

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
		const d = decideTurn(st, { turn, now: Date.now(), text, calls, results, empty: !calls.length && !text.trim() && !hasThinking, lengthStop: m.stopReason === "length", testsExist: !isHelper(from) ? hasTestFiles(ctx.cwd) : undefined, diffStat }, cfg);
		const entries: SessionBoundaryDraft[] = [];
		if (d.reason && d.to === from && d.continue) log(d.message ? "nudge" : "retry", { phase: from, reason: d.reason });
		if (d.to !== from) {
			if (isHelper(from) && !isHelper(d.to)) afterHelper = true;
			log("switch", { from, to: d.to, reason: d.reason, compacted: d.compacted, report: d.report, metrics: st.metrics, model: d.to === "done" ? undefined : isHelper(d.to) ? cfg!.helper : cfg!.lead, costs });
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
		if (st) log("end", { phase: st.phase, costs, metrics: st.metrics, flags: st.flags, budget: budgetSpend(costs, leadId(), cfg!.helperCostFactor), budgetStopped });
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
			"Hand work to the cheaper helper model. kind \"reads\": it reads/searches what you list and you get a harness report with the outputs (limited rounds). kind \"debug\": it runs typecheck/tests/build and fixes failures with small edits, then hands back with a report.",
		parameters: Type.Object({ kind: Type.Union([Type.Literal("reads"), Type.Literal("debug")]), instruction: Type.Optional(Type.String({ description: "What to read, or extra notes for the fix loop." })) }),
		async execute(_id, params) {
			if (params.kind === "reads") return delegateReads(params.instruction ?? "");
			return { content: [{ type: "text" as const, text: "The helper takes over the verify/fix loop now." }], details: {} };
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

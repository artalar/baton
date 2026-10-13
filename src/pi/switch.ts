/**
 * Baton "switch" mode for pi: in-session model switching, one session, the lead model (Opus) leads.
 *   read (helper) → lead plans + writes → debug/verify (helper, escalates after N red cycles) → lead … →
 *   review (helper) → final short check (lead, optional) → done.
 * Load with `-e src/pi/switch.ts`, or `-e src/pi/index.ts` with BATON_MODE=switch.
 * Config: `.pi/baton.json` → { "switch": { …SwitchConfig } }. Journal: `<journalDir>/switch.jsonl`, summary in switch-summary.json.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseModelRef } from "./config.ts";
import { addCost, type Call, type CostRow, DEFAULT_SWITCH, decideTurn, gateCall, initialSwitchState, isHelper, MSG, type Msg, type Result, shapeContext, type SwitchConfig, type SwitchState, capReasoning, capMaxTokens } from "./switch-core.ts";

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
	return { ...DEFAULT_SWITCH, ...over, journalDir };
}

type Block = { type: string; id?: string; name?: string; arguments?: Record<string, unknown>; text?: string; thinking?: string };

export default function batonSwitch(pi: ExtensionAPI) {
	let cfg: (SwitchConfig & { journalDir: string }) | undefined;
	let st: SwitchState | undefined;
	let costs: Record<string, CostRow> = {};
	let dir = "";
	let turn = 0;
	let started = 0;

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
		const s = { phase: st.phase, switches: st.switches.length, followups: st.followups, costs, total: Object.values(costs).reduce((a, r) => a + r.cost, 0), wallS: Math.round((Date.now() - started) / 1000), switchLog: st.switches };
		try {
			writeFileSync(join(dir, "switch-summary.json"), JSON.stringify(s, null, 2));
		} catch {
			/* best effort */
		}
	};

	const init = (ctx: ExtensionContext) => {
		if (cfg) return;
		cfg = loadSwitchConfig(ctx.cwd);
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
		await setModelFor(ctx, "read");
		log("switch", { from: "-", to: "read", reason: "session start: helper reads first" });
		return { message: { customType: "baton-switch-helper", content: MSG.read, display: true } };
	});

	pi.on("tool_call", (e, ctx) => {
		if (!st) return undefined;
		const c: Call = { id: e.toolCallId, name: e.toolName, args: (e.input ?? {}) as Record<string, unknown> };
		const g = gateCall(st, c, (p) => existsSync(isAbsolute(p) ? p : join(ctx.cwd, p)));
		if (g) {
			st.blocked.push(c.id);
			log("blocked", { phase: st.phase, tool: c.name, reason: g.reason });
			return g;
		}
		return undefined;
	});

	pi.on("message_end", (e) => {
		const m = e.message as { role?: string; model?: string; usage?: Parameters<typeof addCost>[2]; responseId?: string; stopReason?: string };
		if (m.role !== "assistant") return undefined;
		costs = addCost(costs, m.model ?? "?", m.usage);
		log("usage", { model: m.model, phase: st?.phase, responseId: m.responseId, stopReason: m.stopReason, cost: m.usage?.cost?.total ?? 0, input: m.usage?.input, output: m.usage?.output, cacheRead: m.usage?.cacheRead, cacheWrite: m.usage?.cacheWrite });
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
		let out = capMaxTokens(e.payload, cfg!.leadMaxTokens);
		if (st.planningLeft <= 0 && cfg!.thinkingCap) out = capReasoning(out, cfg!.thinkingCap);
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
		const d = decideTurn(st, { turn, now: Date.now(), text, calls, results, empty: !calls.length && !text.trim() && !hasThinking }, cfg);
		const entries: SessionBoundaryDraft[] = [];
		if (d.reason && d.to === from && d.continue) log("retry", { phase: from, reason: d.reason });
		if (d.to !== from) {
			log("switch", { from, to: d.to, reason: d.reason, compacted: d.compacted, model: d.to === "done" ? undefined : isHelper(d.to) ? cfg!.helper : cfg!.lead, costs });
			if (d.to !== "done") await setModelFor(ctx, d.to);
			summary();
		}
		if (d.continue && d.to === from && !d.message) entries.push({ type: "custom_message", customType: "baton-switch-lead", content: "[baton switch] The previous response was empty. Continue.", display: true });
		if (d.message) entries.push({ type: "custom_message", customType: d.message.audience === "helper" ? "baton-switch-helper" : "baton-switch-lead", content: d.message.text, display: true });
		if (!entries.length && !d.continue) return undefined;
		return { entries, continue: d.continue };
	});

	pi.on("agent_end", () => {
		if (st) log("end", { phase: st.phase, costs });
		summary();
	});

	pi.registerTool({
		name: "delegate_reads",
		label: "Delegate reads",
		description:
			"Lead model only: hand a batch of file reading / searching to the cheaper helper model. Give an instruction listing what to read or find (files, symbols, docs). The helper runs read-only tools and hands control back with the outputs in the conversation. Limited rounds.",
		parameters: Type.Object({ instruction: Type.String({ description: "What to read or search for, concretely." }) }),
		async execute(_id, params) {
			const left = st ? cfg!.maxFollowups - st.followups : 0;
			return { content: [{ type: "text", text: left > 0 ? `Delegated to the helper: ${params.instruction}` : "No delegated read rounds left — read the files yourself." }], details: { left } };
		},
	});
}

/**
 * Baton for pi: a thin layer over the pi-independent core (src/core). Tools baton_review / baton_help /
 * baton_plan build a review pack with the core and call the advisor; the plan is pinned; review gating,
 * loop detector and triggers live here. Executor-context compaction at handoffs is optional (compact.enabled).
 */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { callAdvisor } from "./advisor.ts";
import { collectPackInput } from "../core/pack/collect.ts";
import { type BatonConfig, loadConfig } from "./config.ts";
import { commitAllowedByGate, finalizeGate, gateOnAdvisor, gateReleaseFinalize, type GateState, helpGate, initialGateState, reviewGate } from "./gate.ts";
import { Journal, type JournalEvent, eventLine, normPath } from "../core/journal.ts";
import { cutLoops, type DeferredItem, deferFire, deferredEditGate, initialLoopState, type LoopState, loopKeys, loopNote, observeLoop, renderDeferred, resolveDeferred } from "./loop.ts";
import { applyHandoff, type HandoffSnapshot, handoffSnapshot, type MsgLike, pinPlan } from "./mask.ts";
import { type AdvisorKind, buildReviewPack, type PackInput } from "../core/pack/index.ts";
import { autoCompactSummary, pickFirstKept, pickFirstKeptForCalls, resetSummary } from "./reset.ts";
import { diffLinesSince, type Exec, git, treeSnapshot, packExcludes } from "../core/repo.ts";
import { type AdvisorReply, renderPlan } from "../core/schema.ts";
import { callFacts, commitGate, isGitCommit, evaluate, initialTriggerState, onAdvisor, onToolResult, planGate, type TriggerState } from "./triggers.ts";
import { clip } from "../core/util.ts";

const SNIPPET_COMPACT = `Baton compaction is ON. Your context is not rewritten while you work. Only at a handoff (an advisor call: baton_review/help/plan, or an automatic one on a loop or a full context) is it reset to task + plan + advisor reply + your last calls; older tool outputs become stubs like "[baton: output masked. evt#12 …]"; call baton_recall({"evt":12}) when you need the full text again. Skill files (SKILL.md) and reference docs are never masked.`;

/** Pure: the system-prompt guidance; the compaction paragraph only when compact.enabled. */
export function systemSnippet(compact: boolean): string {
	return `Baton is active: a stronger reviewer model (one call each, costly — do not spam) sees a prepared pack of your work (task, plan, diff, changed files, tests, project skills). It has no tools and does not trust your claims; the artefacts must speak.${compact ? `\n${SNIPPET_COMPACT}` : ""}
- baton_plan: after a short exploration (read the project skills and the repo first), before writing code. The plan is pinned into every request; follow it.
- baton_step: mark a plan step done/blocked with evidence (command + result). Cheap, no advisor call.
- baton_help: when stuck — the same error twice, or you do not understand a failure. Give your hypothesis, what you tried, and important evt numbers.
- baton_review: at the first milestone (core model works, tests/build green), at the plan's checkpoints, and before git commit. Its plan is appended; follow it.
Review gating: baton_review is refused until ALL review-verified steps of the last review are closed (baton_step done/deferred), or ~15 tool calls / ~80 changed lines accumulated. Do all the fixes, then ONE review — never one fix per review. Steps marked "verify: self" need no re-review: do them, mark them done; if only such steps were left, git commit directly.
Verdict done = finished: only git add/commit (and final tsc/test/build). Do not edit further or ask for another review; optional nits wait.
Stuck rule: if one bug or test still fails after ~3 fix attempts, STOP. Mark the step blocked (baton_step status "blocked", or call baton_help once), treat the item as DEFERRED and move on to the next plan step. Deferred items are resolved only after the reviewer (baton_review) or the user confirms. Baton's loop detector enforces this: when it reports "⚠ Loop detected", do not touch that item again until it is unblocked.`;
}

/** Default guidance (compaction off). */
export const SYSTEM_SNIPPET = systemSnippet(false);

/** Pure: pinned plan text with step status marks. */
export function renderPinned(plan: { reply: AdvisorReply; label: string }, status: Record<string, string>): string {
	const marks = plan.reply.plan.map((st) => `[${status[st.id] === "done" ? "x" : status[st.id] === "blocked" ? "!" : status[st.id] === "deferred" ? "~" : " "}] ${st.id}`).join("  ");
	return `${renderPlan(plan.reply, plan.label)}\nProgress: ${marks || "(no steps)"}\nMark steps with baton_step({id, status, evidence}).`;
}

interface Runtime {
	cfg: BatonConfig;
	journal: Journal;
	triggers: TriggerState;
	turn: number;
	userPrompts: { evt: number; text: string }[];
	lastPlan?: string;
	pinned?: { reply: AdvisorReply; label: string };
	stepStatus: Record<string, string>;
	pendingReset?: { summary: string; kind: AdvisorKind };
	pendingNudge?: string;
	maskStats: { masked: number; deduped: number; stale: number; charsSaved: number };
	loop: LoopState;
	deferred: DeferredItem[];
	/** Frozen view applied to every request since the last handoff (handoff mode). */
	handoff?: HandoffSnapshot;
	/** An automatic handoff to run at the end of the current turn. */
	pendingHandoff?: { kind: AdvisorKind; reason: string; question: string };
	/** Review gating / finalize mode. */
	gate: GateState;
}

/** Pure: the text pinned into every request (plan with progress, then deferred items). */
export function pinnedBlock(plan: { reply: AdvisorReply; label: string } | undefined, status: Record<string, string>, deferred: readonly DeferredItem[]): string | undefined {
	const parts = [plan ? renderPinned(plan, status) : undefined, renderDeferred(deferred)].filter(Boolean);
	return parts.length ? parts.join("\n\n") : undefined;
}

function textOf(content: readonly { type: string; text?: string }[] | undefined): string {
	return (content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
}

export default function baton(pi: ExtensionAPI) {
	let rt: Runtime | undefined;

	const init = (ctx: ExtensionContext): Runtime => {
		if (rt) return rt;
		const cfg = loadConfig(ctx.cwd, (m) => ctx.hasUI && ctx.ui.notify(m, "warning"));
		rt = {
			cfg,
			journal: new Journal(join(ctx.cwd, cfg.journalDir)),
			triggers: initialTriggerState(),
			turn: 0,
			userPrompts: [],
			stepStatus: {},
			maskStats: { masked: 0, deduped: 0, stale: 0, charsSaved: 0 },
			loop: initialLoopState(),
			deferred: [],
			gate: initialGateState(),
		};
		const snap = [...rt.journal.events].reverse().find((e) => e.kind === "note" && (e.data as { deferred?: unknown } | undefined)?.deferred);
		if (snap) rt.deferred = (snap.data as { deferred: DeferredItem[] }).deferred;
		const ho = [...rt.journal.events].reverse().find((e) => e.kind === "note" && (e.data as { handoff?: unknown } | undefined)?.handoff);
		if (ho) rt.handoff = (ho.data as { handoff: HandoffSnapshot }).handoff;
		const gs = [...rt.journal.events].reverse().find((e) => e.kind === "note" && (e.data as { gate?: unknown } | undefined)?.gate);
		if (gs) rt.gate = (gs.data as { gate: GateState }).gate;
		rt.userPrompts = rt.journal.events.filter((e) => e.kind === "user_prompt").map((e) => ({ evt: e.evt, text: e.text ?? "" }));
		return rt;
	};

	const saveDeferred = (r: Runtime, text: string, extra?: Record<string, unknown>) => {
		r.journal.record("note", r.turn, text, { ...extra, deferred: r.deferred });
	};

	const saveGate = (r: Runtime, text: string) => {
		r.journal.record("note", r.turn, text, { gate: r.gate });
	};

	const exec: Exec = async (cmd, args) => {
		const r = await pi.exec(cmd, args, { timeout: 20_000 });
		return { stdout: r.stdout, code: r.code };
	};

	pi.on("session_start", (_e, ctx) => {
		init(ctx);
	});
	pi.on("session_shutdown", () => {
		rt = undefined;
	});
	pi.on("turn_start", (e, ctx) => {
		init(ctx).turn = e.turnIndex;
	});

	// Capture user prompts verbatim (the system-prompt snippet ships as baton_recall promptGuidelines).
	pi.on("before_agent_start", (e, ctx) => {
		const r = init(ctx);
		if (e.messageType === "user" && e.prompt) {
			const ev = r.journal.record("user_prompt", r.turn, e.prompt);
			r.userPrompts.push({ evt: ev.evt, text: e.prompt });
			if (r.gate.finalize) {
				r.gate = gateReleaseFinalize(r.gate); // the user intervened
				saveGate(r, "finalize mode ended: new user prompt");
			}
		}
		return undefined;
	});

	// Commit gate (permission-gate pattern).
	pi.on("tool_call", (e, ctx) => {
		const r = init(ctx);
		const pg = planGate(e.toolName, r.triggers, r.cfg.triggers);
		if (pg) {
			r.triggers = { ...r.triggers, planGateFired: true };
			r.journal.record("note", r.turn, "plan gate: first write blocked once (no plan yet)");
			return pg;
		}
		const p = (e.input as { path?: unknown; file_path?: unknown }).path ?? (e.input as { file_path?: unknown }).file_path;
		const dg = deferredEditGate(e.toolName, typeof p === "string" ? normPath(p, ctx.cwd) : undefined, r.deferred, r.cfg.loop);
		if (dg) {
			r.journal.record("note", r.turn, `deferred gate: blocked ${e.toolName} ${String(p)}`);
			return dg;
		}
		const cmd = e.toolName === "bash" ? String((e.input as { command?: unknown }).command ?? "") : undefined;
		const fg = finalizeGate(e.toolName, cmd, r.gate);
		if (fg) {
			r.gate = { ...r.gate, finalizeWarned: true };
			saveGate(r, `finalize gate: blocked ${e.toolName} once`);
			return fg;
		}
		if (cmd === undefined) return undefined;
		if (commitAllowedByGate(r.gate, r.stepStatus)) return undefined; // after done / all-self steps closed
		return commitGate(cmd, r.triggers, r.cfg.triggers);
	});

	// Journal every tool result.
	pi.on("tool_result", (e, ctx) => {
		const r = init(ctx);
		const sc = e.structuredContent as { exit_code?: number } | undefined;
		const ev = r.journal.recordTool({
			tool: e.toolName,
			toolCallId: e.toolCallId,
			input: e.input,
			output: textOf(e.content),
			isError: e.isError,
			exitCode: e.toolName === "bash" && typeof sc?.exit_code === "number" ? sc.exit_code : undefined,
			turn: r.turn,
			cwd: ctx.cwd,
		});
		const cmd = typeof (e.input as { command?: unknown }).command === "string" ? String((e.input as { command: string }).command) : undefined;
		if (cmd && ev.exit === 0 && isGitCommit(cmd) && r.gate.finalize) {
			r.gate = gateReleaseFinalize(r.gate);
			saveGate(r, "finalize mode ended: commit");
		}
		r.triggers = onToolResult(r.triggers, e.toolName, ev.errSig, (ev.filesWritten?.length ?? 0) > 0, callFacts(e.toolName, cmd, ev.exit, ev.test));
		const usage = ctx.getContextUsage();
		const ratio = usage && usage.tokens !== null && usage.contextWindow ? usage.tokens / usage.contextWindow : null;
		const { nudge, state } = evaluate(r.triggers, r.cfg.triggers, ratio);
		r.triggers = state;
		const compact = r.cfg.compact.enabled;
		if (nudge?.kind === "context" && compact) {
			// context pressure: hand off to the advisor (review) instead of silent masking
			r.pendingHandoff ??= { kind: "review", reason: "auto:context", question: `Context is at ${Math.round((ratio ?? 0) * 100)}% of the window. Review the work so far and give the plan for the rest; the executor's context is reset after your reply.` };
		} else if (nudge) r.pendingNudge = nudge.message;
		if (e.toolCallId && !e.toolName.startsWith("baton_")) {
			const keys = loopKeys({ toolCallId: e.toolCallId, tool: e.toolName, input: e.input as Record<string, unknown>, output: textOf(e.content), isError: e.isError }, ctx.cwd, r.cfg.loop.ignoreReadPaths);
			const lr = observeLoop(r.loop, e.toolCallId, keys, r.cfg.loop);
			r.loop = lr.state;
			if (lr.fire) {
				const { list, item } = deferFire(r.deferred, lr.fire);
				r.deferred = list;
				saveDeferred(r, `loop detected: ${item.id} ${item.target}, ${lr.fire.count} calls${item.sig ? `, ${item.sig}` : ""}`, { loop: lr.fire });
				if (r.cfg.loop.action === "help") {
					// force baton_help; the looping calls are cut only by a compaction handoff (compact.enabled)
					r.pendingHandoff = { kind: "help", reason: "auto:loop", question: loopNote(item, lr.fire.count) };
					r.pendingNudge = undefined;
				} else r.pendingNudge = loopNote(item, lr.fire.count);
			}
		}
		return undefined;
	});

	// Outgoing request only (session stays complete). Compaction on: apply the frozen snapshot of the last
	// handoff (stubs + loop cuts). Compaction off: nothing is masked; only the pinned plan is added.
	pi.on("context", (e, ctx) => {
		const r = init(ctx);
		let msgs = e.messages as unknown as MsgLike[];
		if (r.cfg.compact.enabled) {
			const lookup = (id: string) => r.journal.forCall(id);
			const opts = { enabled: true, exemptTools: r.cfg.compact.exemptTools, neverMaskPaths: r.cfg.compact.neverMaskPaths, dedupReads: false, staleReads: false, cwd: ctx.cwd };
			const { messages, stats } = applyHandoff(msgs, r.handoff, lookup, opts);
			r.maskStats = stats;
			msgs = r.handoff?.cut.length ? cutLoops(messages, r.handoff.cut).messages : messages;
		}
		const pin = r.cfg.pack.pinPlan ? pinnedBlock(r.pinned, r.stepStatus, r.deferred) : undefined;
		const out = pin ? pinPlan(msgs, pin) : msgs;
		return { messages: out as unknown as typeof e.messages };
	});

	// Turn boundary: apply a pending reset (compaction entry) or deliver a nudge.
	pi.on("turn_end", async (e, ctx) => {
		const r = init(ctx);
		const entries: SessionBoundaryDraft[] = [];
		let handoffMsg: string | undefined;
		if (r.pendingHandoff && !r.pendingReset) {
			const h = r.pendingHandoff;
			r.pendingHandoff = undefined;
			const extra: Partial<PackInput> =
				h.kind === "help" ? { hypothesis: `(automatic) ${h.question}`, attempts: [], question: "The executor is looping on this item. Rule on it (deferred_rulings) and give the plan to continue.", reason: h.reason } : { question: h.question, reason: h.reason };
			const out = await handoff(h.kind, extra, ctx);
			handoffMsg = `Baton automatic handoff (${h.reason}) → baton_${h.kind}:\n${out.text}`;
		}
		if (r.pendingReset) {
			const all = e.context.contextEntries.map((p) => p.sourceEntry) as unknown as { id: string; type: string; message?: { role?: string; content?: unknown } }[];
			const keepIds = r.handoff ? keptCalls(r) : [];
			entries.push({
				type: "compaction",
				summary: r.pendingReset.summary,
				firstKeptEntryId: pickFirstKeptForCalls(all, keepIds, pickFirstKept(all, r.cfg.compact.keepTurns)) ?? e.messageEntryId,
				details: { baton: true, kind: r.pendingReset.kind },
			});
			r.journal.record("reset", r.turn, `context reset after baton_${r.pendingReset.kind}`);
			r.pendingReset = undefined;
		}
		if (handoffMsg) entries.push({ type: "custom_message", customType: "baton-handoff", content: handoffMsg, display: true });
		if (r.pendingNudge) {
			entries.push({ type: "custom_message", customType: "baton-nudge", content: r.pendingNudge, display: true });
			r.pendingNudge = undefined;
		}
		return entries.length ? { entries } : undefined;
	});

	// Replace pi's LLM compaction with Baton's deterministic summary (or a pending reset).
	pi.on("session_before_compact", async (e, ctx) => {
		const r = init(ctx);
		const { firstKeptEntryId, tokensBefore } = e.preparation;
		if (r.pendingReset) {
			const summary = r.pendingReset.summary;
			r.pendingReset = undefined;
			return { compaction: { summary, firstKeptEntryId, tokensBefore, details: { baton: true } } };
		}
		if (e.reason === "manual" || !r.cfg.compact.enabled || !r.cfg.compact.replaceAutoCompact) return undefined;
		// pi's auto-compaction is routed through a handoff: advisor review, then Baton's reset
		r.pendingHandoff = undefined;
		const out = await handoff("review", { question: `pi auto-compaction (${e.reason}): the context is full. Review the work so far and give the plan for the rest.`, reason: `auto:compact:${e.reason}` }, ctx, e.signal);
		if (!out.ok) takeSnapshot(r, "review", `auto-compaction (${e.reason}), advisor failed`);
		const summary = (r.pendingReset as Runtime["pendingReset"])?.summary ?? autoCompactSummary(r.userPrompts[0]?.text ?? "", r.userPrompts.map((p) => p.text), r.lastPlan, r.journal.events.filter((x) => (x.importance ?? 0) >= 2).slice(-80));
		r.pendingReset = undefined;
		return { compaction: { summary, firstKeptEntryId, tokensBefore, details: { baton: true, auto: e.reason, handoff: true } } };
	});

	// ---- tools ---------------------------------------------------------------

	pi.registerTool({
		name: "baton_recall",
		label: "Baton recall",
		description: "Return the full raw output of a journal event (evt number from the Baton journal or a stub). Large outputs are clipped; use offset to page.",
		promptSnippet: "baton_recall(evt): full output of a masked tool result",
		promptGuidelines: systemSnippet(loadConfig(process.cwd()).compact.enabled).split("\n"),
		parameters: Type.Object({
			evt: Type.Number({ description: "Event number, e.g. 12 for evt#12" }),
			offset: Type.Optional(Type.Number({ description: "Character offset to start from (default 0)" })),
			maxChars: Type.Optional(Type.Number({ description: "Max characters to return (default 20000)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const r = init(ctx);
			const ev = r.journal.get(params.evt);
			if (!ev) return { content: [{ type: "text", text: `No journal event evt#${params.evt}.` }], details: undefined };
			const raw = r.journal.raw(params.evt) ?? ev.text ?? "";
			const off = Math.max(0, params.offset ?? 0);
			const max = Math.max(500, params.maxChars ?? 20_000);
			const slice = raw.slice(off, off + max);
			const more = off + max < raw.length ? `\n[… ${raw.length - off - max} more chars; call again with offset=${off + max}]` : "";
			return { content: [{ type: "text", text: `${eventLine(ev)}\n${slice}${more}` }], details: { evt: ev.evt } };
		},
	});

	pi.registerTool({
		name: "baton_step",
		label: "Baton step",
		description: "Mark a step of the pinned advisor plan as done, in_progress, blocked or deferred, with evidence (command and result). Use deferred when one bug/test resists ~3 fix attempts: it is parked until the reviewer or user confirms, and you move on. No advisor call; cheap.",
		promptSnippet: "baton_step(id, status, evidence): track progress on the pinned plan",
		parameters: Type.Object({
			id: Type.String({ description: "Plan step id, e.g. S2" }),
			status: Type.Union([Type.Literal("done"), Type.Literal("in_progress"), Type.Literal("blocked"), Type.Literal("deferred")]),
			evidence: Type.Optional(Type.String({ description: "Command run and its result that proves the done criterion" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const r = init(ctx);
			if (!r.pinned) return { content: [{ type: "text", text: "No pinned plan yet. Call baton_plan first." }], details: { ok: false } };
			const step = r.pinned.reply.plan.find((x) => x.id === params.id);
			if (!step) return { content: [{ type: "text", text: `Unknown step ${params.id}. Steps: ${r.pinned.reply.plan.map((x) => x.id).join(", ")}` }], details: { ok: false } };
			r.stepStatus[params.id] = params.status;
			if (params.status === "deferred") {
				const { list, item } = deferFire(r.deferred, { kind: "test", key: `step:${params.id}`, target: `step ${params.id} (${step.action.slice(0, 80)})`, count: 0, span: [], files: [], sig: params.evidence?.slice(0, 160), at: r.loop.n });
				r.deferred = list;
				saveDeferred(r, `executor deferred ${item.id}: step ${params.id}`);
			}
			r.journal.record("note", r.turn, `step ${params.id}: ${params.status}${params.evidence ? ` — ${params.evidence}` : ""}`, { step: params.id, status: params.status });
			const checkpoint = params.status === "done" && (r.pinned.reply.checkpoints ?? []).includes(params.id);
			const left = r.pinned.reply.plan.filter((x) => r.stepStatus[x.id] !== "done" && r.stepStatus[x.id] !== "deferred").map((x) => x.id);
			const next = checkpoint
				? `Checkpoint ${params.id} reached: call baton_review now.`
				: left.length
					? `Next: ${left[0]} — ${r.pinned.reply.plan.find((x) => x.id === left[0])!.done_when ? `done when ${r.pinned.reply.plan.find((x) => x.id === left[0])!.done_when}` : ""}`
					: commitAllowedByGate(r.gate, r.stepStatus)
					? "All steps done (verify:self): run the checks and git commit; no re-review needed."
					: "All steps done: call baton_review.";
			return { content: [{ type: "text", text: `Step ${params.id} → ${params.status}. ${next}` }], details: { ok: true, step: params.id, status: params.status, checkpoint } };
		},
	});

	async function runAdvisor(kind: AdvisorKind, extra: Partial<PackInput> & { importantEvts?: number[] }, ctx: ExtensionContext, signal?: AbortSignal) {
		const r = init(ctx);
		const open = r.deferred.filter((d) => d.status === "deferred");
		const deferred =
			kind === "review" && open.length
				? open
						.map((d) => {
							const last = [...d.cut].reverse().map((id) => r.journal.forCall(id)).find((x) => x && (x.errSig || x.test));
							return `${d.id}: ${d.target}${d.sig ? ` — ${d.sig}` : ""} (${d.count} calls)${d.files.length ? `\nfiles: ${d.files.join(", ")}` : ""}${last ? `\nlast failing call:\n${clip(`${eventLine(last)}\n${r.journal.raw(last.evt) ?? last.outTail ?? ""}`, 3000)}` : ""}`;
						})
						.join("\n\n")
				: undefined;
		const input = await collectPackInput({
			kind,
			cwd: ctx.cwd,
			exec,
			journal: r.journal,
			task: r.userPrompts[0]?.text ?? "",
			userPrompts: r.userPrompts,
			plan: r.pinned ? renderPinned(r.pinned, r.stepStatus) : r.lastPlan,
			question: extra.question,
			reason: extra.reason,
			hypothesis: extra.hypothesis,
			attempts: extra.attempts,
			importantEvts: extra.importantEvts,
			helpLastCalls: r.cfg.pack.helpLastCalls,
			deferred,
			excludePaths: r.cfg.pack.excludePaths,
			journalDir: r.cfg.journalDir,
			budgetTokens: r.cfg.pack.budgetTokens,
			skills: { enabled: r.cfg.pack.skills.enabled, dirs: r.cfg.pack.skills.dirs, maxSkills: r.cfg.pack.skills.maxSkills, budgetTokens: Math.floor(r.cfg.pack.budgetTokens * r.cfg.pack.skills.budgetRatio) },
		});
		const pack = buildReviewPack(input, { budgetTokens: r.cfg.pack.budgetTokens });
		r.journal.record("note", r.turn, `baton_${kind} pack built: ${pack.tokens} tok (stable prefix ${pack.stableTokens})`, { sections: pack.sections, skills: input.skills?.map((k) => k.name) ?? [] });
		const res = await callAdvisor(ctx, r.cfg.advisor.model, pack.messages, { maxTokens: r.cfg.advisor.maxTokens, cache: r.cfg.advisor.cache, signal });
		return { r, pack, res };
	}

	/** toolCallIds of the executor's own (non-Baton) tool calls, in order. */
	const executorCalls = (r: Runtime) => r.journal.toolEvents().flatMap((e) => (e.toolCallId && !(e.tool ?? "").startsWith("baton_") ? [e.toolCallId] : []));
	const keepFor = (r: Runtime, kind: AdvisorKind) => (kind === "help" ? r.cfg.pack.helpLastCalls : r.cfg.compact.keepCalls);
	const keptCalls = (r: Runtime) => {
		const stubbed = new Set(r.handoff?.stub ?? []);
		return executorCalls(r).filter((id) => !stubbed.has(id));
	};

	/** Freeze the executor's view at a handoff: older outputs → stubs, deferred loops → cut. */
	function takeSnapshot(r: Runtime, kind: AdvisorKind, why: string) {
		r.handoff = handoffSnapshot((r.handoff?.n ?? 0) + 1, executorCalls(r), keepFor(r, kind), r.deferred);
		r.journal.record("note", r.turn, `handoff #${r.handoff.n} (baton_${kind}, ${why}): ${r.handoff.stub.length} outputs → stubs, ${r.handoff.cut.length} loop(s) cut`, { handoff: r.handoff });
	}

	/** One advisor call (a handoff). In handoff mode a successful call also resets the executor's context. */
	async function handoff(kind: AdvisorKind, extra: Partial<PackInput> & { importantEvts?: number[] }, ctx: ExtensionContext, signal?: AbortSignal) {
		const { r, pack, res } = await runAdvisor(kind, extra, ctx, signal);
		if (!res.ok || !res.reply) {
			r.journal.record("advisor", r.turn, `baton_${kind} failed: ${(res.errors ?? []).join("; ")}`, { raw: res.raw, usage: res.usage, attempts: res.attempts });
			const fallback = res.raw ? `\nRaw advisor reply (unvalidated):\n${clip(res.raw, 8000)}` : "";
			return { ok: false, text: `Baton ${kind}: advisor call failed (${(res.errors ?? ["unknown"]).join("; ")}).${fallback}`, details: { ok: false, packTokens: pack.tokens, attempts: res.attempts, usage: res.usage }, usage: res.usage };
		}
		const plan = renderPlan(res.reply, `baton_${kind}`, res.truncated);
		r.lastPlan = plan;
		r.journal.record("advisor", r.turn, `baton_${kind}: ${res.reply.verdict}`, { ...res.reply, usage: res.usage, attempts: res.attempts, packTokens: pack.tokens, reason: extra.reason });
		r.triggers = onAdvisor(r.triggers, kind, res.reply.verdict, res.reply.plan.length);
		r.gate = gateOnAdvisor(r.gate, kind, res.reply.verdict, res.reply.plan, executorCalls(r).length, kind === "review" ? await treeSnapshot(exec) : undefined, r.cfg.review);
		saveGate(r, `gate after baton_${kind}: ${res.reply.verdict}${r.gate.finalize ? " → finalize mode" : ""}`);
		if (res.reply.deferred_rulings?.length && r.deferred.length) {
			r.deferred = resolveDeferred(r.deferred, res.reply.deferred_rulings, "reviewer");
			saveDeferred(r, `deferred rulings from baton_${kind}: ${res.reply.deferred_rulings.map((d) => `${d.id}=${d.ruling}`).join(", ")}`);
		}
		if (res.reply.plan.length && res.reply.verdict !== "done") {
			r.pinned = { reply: res.reply, label: `baton_${kind}` };
			r.stepStatus = {};
		}
		const compact = r.cfg.compact.enabled;
		let tail = "";
		const selfN = res.reply.plan.filter((s) => s.verify === "self").length;
		if (kind === "review")
			tail = r.gate.finalize
				? "\nVerdict done: FINALIZE. Run git add + git commit now (final tsc/test/build allowed). No more edits, no further baton_review until you commit."
				: r.triggers.reviewPassed
					? `\nReview passed: git commit is allowed.${selfN ? " Do the verify:self steps first and mark them done." : ""}`
					: selfN === res.reply.plan.length && selfN
						? "\nAll fixes are verify:self: do them, mark each done with baton_step, then git commit (no re-review needed)."
						: "\nReview did not pass: do ALL the steps above (verify:self ones need no re-review), mark each with baton_step, then call baton_review once.";
		if (compact) {
			const diffStat = (await git(exec, ["diff", "--stat", "HEAD"])) ?? undefined;
			r.pendingReset = { kind, summary: resetSummary({ task: r.userPrompts[0]?.text ?? "", userPrompts: r.userPrompts.map((p) => p.text), plan, diffStat, note: renderDeferred(r.deferred) || undefined }) };
			takeSnapshot(r, kind, String(extra.reason ?? `self:${kind}`));
			const keep = keepFor(r, kind);
			tail += `\nYour context will now be reset to the task + this plan${keep ? ` + your last ${keep} tool outputs` : ""}; older outputs become evt# stubs (baton_recall). Until the next advisor call nothing is rewritten. Continue with the next step.`;
		}
		return { ok: true, text: `${plan}${tail}`, details: { ok: true, verdict: res.reply.verdict, packTokens: pack.tokens, model: res.model, attempts: res.attempts, usage: res.usage }, usage: res.usage };
	}

	const advisorParams = {
		review: Type.Object({
			note: Type.Optional(Type.String({ description: "Optional: what you think is done (the reviewer does not trust it)" })),
		}),
		help: Type.Object({
			hypothesis: Type.String({ description: "Your current hypothesis about the cause" }),
			attempts: Type.Array(Type.String(), { description: "What you tried and what happened" }),
			importantEvts: Type.Optional(Type.Array(Type.Number(), { description: "evt numbers you consider important" })),
			question: Type.Optional(Type.String({ description: "The concrete question for the advisor" })),
		}),
		plan: Type.Object({
			question: Type.Optional(Type.String({ description: "Optional focus or constraints for the plan" })),
		}),
	};

	const descriptions: Record<AdvisorKind, string> = {
		review: "Ask the stronger advisor model to review the current work (task, user prompts, git diff, changed files, last test run). Required before git commit. Appends the advisor's plan. Refused while review-verified steps of the last review are open (unless ~15 calls / ~80 changed lines accumulated) and after a done verdict until you commit: batch all fixes into one review.",
		help: "Ask the stronger advisor model for help when stuck (same error repeated, unclear failure; not right after another advisor reply — apply it first). Sends your last tool calls verbatim plus your hypothesis and attempts.",
		plan: "Ask the stronger advisor model for a plan (task, project skills, AGENTS.md, repo map, your exploration findings). Call it after exploring and before writing code. The plan is pinned into every request.",
	};

	for (const kind of ["review", "help", "plan"] as const) {
		pi.registerTool({
			name: `baton_${kind}`,
			label: `Baton ${kind}`,
			description: descriptions[kind],
			promptSnippet: `baton_${kind}: ${descriptions[kind].split(".")[0]}`,
			parameters: advisorParams[kind] as any,
			async execute(_id, params: any, signal, _onUpdate, ctx) {
				const extra: Partial<PackInput> & { importantEvts?: number[] } =
					kind === "help"
						? { hypothesis: params.hypothesis, attempts: params.attempts, importantEvts: params.importantEvts, question: params.question, reason: "self:stuck" }
						: { question: params.question ?? params.note, reason: `self:${kind}` };
				const r = init(ctx);
				const calls = executorCalls(r).length;
				let refusal: string | undefined;
				if (kind === "review") {
					let d = reviewGate(r.gate, r.cfg.review, { calls, status: r.stepStatus });
					if (!d.allow && d.needDiff) {
						const from = r.gate.lastReview?.tree;
						const diffLines = from ? await diffLinesSince(exec, from, packExcludes(r.cfg.journalDir, r.cfg.pack.excludePaths)) : undefined;
						d = reviewGate(r.gate, r.cfg.review, { calls, status: r.stepStatus, diffLines: diffLines ?? 0 });
					}
					if (!d.allow) refusal = d.reason;
				} else if (kind === "help") {
					const d = helpGate(r.gate, r.cfg.review, calls);
					if (!d.allow) refusal = d.reason;
				}
				if (refusal) {
					r.journal.record("note", r.turn, `baton_${kind} refused by gate`, { refused: kind, reason: refusal });
					return { content: [{ type: "text", text: refusal }], details: { ok: false, refused: true } };
				}
				const out = await handoff(kind, extra, ctx, signal);
				return { content: [{ type: "text", text: out.text }], details: out.details, usage: out.usage as any };
			},
		});
	}

	// ---- commands ------------------------------------------------------------

	pi.registerCommand("baton", {
		description: "Baton status | reset (compact to task + last plan now) | unblock <D1|all> [guidance] | drop <D1|all>",
		handler: async (args, ctx) => {
			const r = init(ctx);
			const m = args.trim().match(/^(unblock|drop)\s+(\S+)\s*(.*)$/);
			if (m) {
				const before = r.deferred.filter((d) => d.status === "deferred").length;
				r.deferred = resolveDeferred(r.deferred, [{ id: m[2]!, ruling: m[1] as "unblock" | "drop", guidance: m[3] || undefined }], "user");
				const changed = before - r.deferred.filter((d) => d.status === "deferred").length;
				saveDeferred(r, `user ${m[1]} ${m[2]}${m[3] ? `: ${m[3]}` : ""}`);
				ctx.ui.notify(changed ? `Baton: ${m[1]} ${m[2]} (${changed} item(s)).` : `Baton: no deferred item ${m[2]}.`, changed ? "info" : "warning");
				return;
			}
			if (args.trim() === "reset") {
				r.pendingReset = { kind: "plan", summary: resetSummary({ task: r.userPrompts[0]?.text ?? "", userPrompts: r.userPrompts.map((p) => p.text), plan: r.lastPlan ?? "(no plan yet)" }) };
				ctx.compact({ onError: (err) => ctx.ui.notify(`Baton reset failed: ${err.message}`, "error") });
				return;
			}
			const t = r.triggers;
			const s = r.maskStats;
			ctx.ui.notify(
				[
					`Baton: ${r.journal.events.length} events in ${r.cfg.journalDir}`,
					`tool calls ${t.toolCalls}, since advisor ${t.toolCalls - t.lastAdvisorAt}, review passed: ${t.reviewPassed}, finalize: ${r.gate.finalize}, open review steps: ${(r.gate.lastReview?.steps ?? []).filter((x) => x.verify === "review" && r.stepStatus[x.id] !== "done" && r.stepStatus[x.id] !== "deferred").map((x) => x.id).join(",") || "none"}`,
					`compaction ${r.cfg.compact.enabled ? `on, handoffs ${r.handoff?.n ?? 0}; last request: stubbed ${s.masked}, ~${Math.round(s.charsSaved / 2.4)} tok saved` : "off"}`,
					`plan: ${r.pinned ? `${r.pinned.label}, ${Object.values(r.stepStatus).filter((x) => x === "done").length}/${r.pinned.reply.plan.length} steps done` : "none"}`,
					`deferred: ${r.deferred.length ? r.deferred.map((d) => `${d.id} ${d.status} (${d.target})`).join("; ") : "none"}`,
					`advisor ${r.cfg.advisor.model} (cache ${r.cfg.advisor.cache})`,
				].join("\n"),
				"info",
			);
		},
	});
}

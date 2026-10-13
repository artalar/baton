/**
 * Baton for pi: deterministic tool journal, output masking, one-shot advisor tools
 * (baton_review / baton_help / baton_plan), context reset and safety triggers.
 */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AdvisorResult, callAdvisor } from "./advisor.ts";
import { type BatonConfig, loadConfig } from "./config.ts";
import { Journal, type JournalEvent, eventLine, normPath } from "./journal.ts";
import { filterEvents, type JudgeProvider } from "./judge.ts";
import { jevJudge } from "./judge-jev.ts";
import { cutLoops, type DeferredItem, deferFire, deferredEditGate, initialLoopState, type LoopState, loopKeys, loopNote, observeLoop, renderDeferred, resolveDeferred } from "./loop.ts";
import { maskMessages, type MsgLike, pinPlan } from "./mask.ts";
import { type AdvisorKind, buildPack, type PackInput, type VerbatimCall } from "./pack.ts";
import { autoCompactSummary, pickFirstKept, resetSummary } from "./reset.ts";
import { changedFiles, type Exec, git, packDiff, packExcludes, readAgentsMd, repoMap } from "./repo.ts";
import { discoverSkills, selectSkills } from "./skills.ts";
import { type AdvisorReply, renderPlan } from "./schema.ts";
import { callFacts, commitGate, evaluate, initialTriggerState, onAdvisor, onToolResult, planGate, type TriggerState } from "./triggers.ts";
import { clip } from "./util.ts";

export const SYSTEM_SNIPPET = `Baton is active. Tool outputs you have already seen are replaced by stubs like "[baton: output masked. evt#12 …]"; call baton_recall({"evt":12}) when you need the full text again.
Use the advisor tools (a stronger model, one call each, costly — do not spam):
- baton_plan: after a short exploration (read the project skills and the repo first), before writing code; again when the context is getting long. The plan is pinned into every request; follow it.
- baton_step: mark a plan step done/blocked with evidence (command + result). Cheap, no advisor call.
- baton_help: when stuck — the same error twice, or you do not understand a failure. Give your hypothesis, what you tried, and important evt numbers. Resets your context to task + plan.
- baton_review: at the first milestone (core model works, tests/build green), at the plan's checkpoints, and always before git commit. Its plan is appended; follow it.
Stuck rule: if one bug or test still fails after ~3 fix attempts, STOP. Mark the step blocked (baton_step status "blocked", or call baton_help once), treat the item as DEFERRED and move on to the next plan step. Deferred items are resolved only after the reviewer (baton_review) or the user confirms. Baton's loop detector enforces this: when it reports "⚠ Loop detected", do not touch that item again until it is unblocked.
Skill files (SKILL.md) and reference docs are never masked.`;

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
		};
		const snap = [...rt.journal.events].reverse().find((e) => e.kind === "note" && (e.data as { deferred?: unknown } | undefined)?.deferred);
		if (snap) rt.deferred = (snap.data as { deferred: DeferredItem[] }).deferred;
		rt.userPrompts = rt.journal.events.filter((e) => e.kind === "user_prompt").map((e) => ({ evt: e.evt, text: e.text ?? "" }));
		return rt;
	};

	const saveDeferred = (r: Runtime, text: string, extra?: Record<string, unknown>) => {
		r.journal.record("note", r.turn, text, { ...extra, deferred: r.deferred });
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
		if (e.toolName !== "bash") return undefined;
		const cmd = String((e.input as { command?: unknown }).command ?? "");
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
		r.triggers = onToolResult(r.triggers, e.toolName, ev.errSig, (ev.filesWritten?.length ?? 0) > 0, callFacts(e.toolName, cmd, ev.exit, ev.test));
		const usage = ctx.getContextUsage();
		const ratio = usage && usage.tokens !== null && usage.contextWindow ? usage.tokens / usage.contextWindow : null;
		const { nudge, state } = evaluate(r.triggers, r.cfg.triggers, ratio);
		r.triggers = state;
		if (nudge) r.pendingNudge = nudge.message;
		if (e.toolCallId && !e.toolName.startsWith("baton_")) {
			const keys = loopKeys({ toolCallId: e.toolCallId, tool: e.toolName, input: e.input as Record<string, unknown>, output: textOf(e.content), isError: e.isError }, ctx.cwd, r.cfg.loop.ignoreReadPaths);
			const lr = observeLoop(r.loop, e.toolCallId, keys, r.cfg.loop);
			r.loop = lr.state;
			if (lr.fire) {
				const { list, item } = deferFire(r.deferred, lr.fire);
				r.deferred = list;
				saveDeferred(r, `loop detected: ${item.id} ${item.target}, ${lr.fire.count} calls${item.sig ? `, ${item.sig}` : ""}`, { loop: lr.fire });
				if (!r.cfg.loop.cutContext) r.pendingNudge = loopNote(item, lr.fire.count);
				else r.pendingNudge = undefined; // the note replaces the looping calls in the context
			}
		}
		return undefined;
	});

	// Mask outputs in the outgoing request only (session stays complete).
	pi.on("context", (e, ctx) => {
		const r = init(ctx);
		const { messages, stats } = maskMessages(e.messages as unknown as MsgLike[], (id) => r.journal.forCall(id), { ...r.cfg.mask, cwd: ctx.cwd });
		r.maskStats = stats;
		const cut = r.cfg.loop.cutContext ? cutLoops(messages, r.deferred).messages : messages;
		const pin = r.cfg.pack.pinPlan ? pinnedBlock(r.pinned, r.stepStatus, r.deferred) : undefined;
		const out = pin ? pinPlan(cut, pin) : cut;
		return { messages: out as unknown as typeof e.messages };
	});

	// Turn boundary: apply a pending reset (compaction entry) or deliver a nudge.
	pi.on("turn_end", (e, ctx) => {
		const r = init(ctx);
		const entries: SessionBoundaryDraft[] = [];
		if (r.pendingReset) {
			const all = e.context.contextEntries.map((p) => p.sourceEntry) as unknown as { id: string; type: string; message?: { role?: string } }[];
			entries.push({
				type: "compaction",
				summary: r.pendingReset.summary,
				firstKeptEntryId: pickFirstKept(all, r.cfg.reset.keepTurns) ?? e.messageEntryId,
				details: { baton: true, kind: r.pendingReset.kind },
			});
			r.journal.record("reset", r.turn, `context reset after baton_${r.pendingReset.kind}`);
			r.pendingReset = undefined;
		}
		if (r.pendingNudge) {
			entries.push({ type: "custom_message", customType: "baton-nudge", content: r.pendingNudge, display: true });
			r.pendingNudge = undefined;
		}
		return entries.length ? { entries } : undefined;
	});

	// Replace pi's LLM compaction with Baton's deterministic summary (or a pending reset).
	pi.on("session_before_compact", (e, ctx) => {
		const r = init(ctx);
		const { firstKeptEntryId, tokensBefore } = e.preparation;
		if (r.pendingReset) {
			const summary = r.pendingReset.summary;
			r.pendingReset = undefined;
			return { compaction: { summary, firstKeptEntryId, tokensBefore, details: { baton: true } } };
		}
		if (e.reason === "manual" || !r.cfg.replaceAutoCompact) return undefined;
		const task = r.userPrompts[0]?.text ?? "";
		const timeline = r.journal.events.filter((x) => (x.importance ?? 0) >= 2).slice(-80);
		const summary = autoCompactSummary(task, r.userPrompts.map((p) => p.text), r.lastPlan, timeline);
		return { compaction: { summary, firstKeptEntryId, tokensBefore, details: { baton: true, auto: e.reason } } };
	});

	// ---- tools ---------------------------------------------------------------

	pi.registerTool({
		name: "baton_recall",
		label: "Baton recall",
		description: "Return the full raw output of a journal event (evt number from a Baton stub). Large outputs are clipped; use offset to page.",
		promptSnippet: "baton_recall(evt): full output of a masked tool result",
		promptGuidelines: SYSTEM_SNIPPET.split("\n"),
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
					: "All steps done: call baton_review.";
			return { content: [{ type: "text", text: `Step ${params.id} → ${params.status}. ${next}` }], details: { ok: true, step: params.id, status: params.status, checkpoint } };
		},
	});

	const verbatim = (r: Runtime, e: JournalEvent, maxChars = 6000): VerbatimCall => ({
		event: e,
		args: e.argsDigest ?? "",
		output: clip(r.journal.raw(e.evt) ?? `${e.outHead ?? ""}\n${e.outTail ?? ""}`, maxChars),
	});

	async function runAdvisor(kind: AdvisorKind, extra: Partial<PackInput>, ctx: ExtensionContext, signal?: AbortSignal) {
		const r = init(ctx);
		const task = r.userPrompts[0]?.text ?? "";
		const pinnedText = r.pinned ? renderPinned(r.pinned, r.stepStatus) : r.lastPlan;
		const open = r.deferred.filter((d) => d.status === "deferred");
		const base: PackInput = { kind, task, userPrompts: r.userPrompts, previousPlan: pinnedText, ...extra };
		const tools = r.journal.toolEvents();
		const excludes = packExcludes(r.cfg.journalDir, r.cfg.pack.excludePaths);
		base.agentsMd = readAgentsMd(ctx.cwd);

		if (kind === "review") {
			base.diffStat = await packDiff(exec, ["--stat"], excludes);
			base.diff = (await packDiff(exec, [], excludes)) ?? "";
			base.changedFiles = await changedFiles(exec, ctx.cwd, 400, excludes);
			const lt = [...tools].reverse().find((e) => e.test);
			if (lt) base.lastTest = verbatim(r, lt, 8000);
			if (open.length)
				base.deferred = open
					.map((d) => {
						const last = [...d.cut].reverse().map((id) => r.journal.forCall(id)).find((x) => x && (x.errSig || x.test));
						return `${d.id}: ${d.target}${d.sig ? ` — ${d.sig}` : ""} (${d.count} calls, cut from the executor's context)${d.files.length ? `\nfiles: ${d.files.join(", ")}` : ""}${last ? `\nlast failing call:\n${clip(`${eventLine(last)}\n${r.journal.raw(last.evt) ?? last.outTail ?? ""}`, 3000)}` : ""}`;
					})
					.join("\n\n");
			// review sees artefacts + the pinned plan (as a contract), never the executor's narrative
		} else if (kind === "help") {
			base.diffStat = await packDiff(exec, ["--stat"], excludes);
			const last = tools.slice(-r.cfg.help.lastCalls);
			base.lastCalls = last.map((e) => verbatim(r, e));
			const sigs = new Set(last.flatMap((e) => (e.errSig ? [e.errSig] : [])));
			const lastIds = new Set(last.map((e) => e.evt));
			base.sameErrorCalls = tools.filter((e) => e.errSig && sigs.has(e.errSig) && !lastIds.has(e.evt)).slice(-6).map((e) => verbatim(r, e, 3000));
			const imp = (extra as { importantEvts?: number[] }).importantEvts ?? [];
			base.important = imp.flatMap((n) => {
				const e = r.journal.get(n);
				return e ? [verbatim(r, e)] : [];
			});
			let judge: JudgeProvider | undefined;
			if (r.cfg.judge.enabled) judge = jevJudge(ctx, r.cfg.judge.model);
			base.timeline = (await filterEvents(tools.slice(-120), task, judge, r.cfg.judge.minConfidence, signal)).kept.filter((e) => !lastIds.has(e.evt)).slice(-60);
		} else {
			base.diffStat = await packDiff(exec, ["--stat"], excludes);
			base.timeline = tools.filter((e) => (e.importance ?? 0) >= 1).slice(-60);
			const files = ((await git(exec, ["ls-files"])) ?? "").split("\n").filter(Boolean).slice(0, 2000);
			const { readFileSync } = await import("node:fs");
			base.repoMap = repoMap(files, (p) => {
				try {
					return readFileSync(join(ctx.cwd, p), "utf8");
				} catch {
					return undefined;
				}
			}, 16_000);
		}

		if (r.cfg.pack.skills.enabled) {
			const all = discoverSkills(ctx.cwd, r.cfg.pack.skills.dirs);
			if (all.length) {
				const hay = [
					kind,
					task,
					...r.userPrompts.map((p) => p.text),
					base.question ?? "",
					base.diff ?? "",
					...(base.changedFiles ?? []).map((f) => `${f.path}\n${f.content.slice(0, 4000)}`),
					base.repoMap ?? "",
					base.hypothesis ?? "",
					...(base.lastCalls ?? []).map((c) => `${c.args}\n${c.output.slice(0, 1000)}`),
				].join("\n");
				const pick = selectSkills(all, hay, Math.floor(r.cfg.packBudgetTokens * r.cfg.pack.skills.budgetRatio), {
					maxSkills: r.cfg.pack.skills.maxSkills,
					prefer: kind === "review" ? /review/i : undefined,
				});
				base.skills = pick.skills;
			}
		}
		const pack = buildPack(base, r.cfg.packBudgetTokens);
		r.journal.record("note", r.turn, `baton_${kind} pack built: ${pack.tokens} tok`, { sections: pack.sections, skills: base.skills?.map((k) => k.name) ?? [] });
		const res: AdvisorResult = await callAdvisor(ctx, r.cfg.advisor, pack.text, r.cfg.advisorMaxTokens, signal);
		return { r, pack, res };
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
		review: "Ask the stronger advisor model to review the current work (task, user prompts, git diff, changed files, last test run). Required before git commit. Appends the advisor's plan.",
		help: "Ask the stronger advisor model for help when stuck (same error repeated, unclear failure). Sends your last tool calls verbatim plus your hypothesis and attempts. Afterwards your context is reset to task + plan + last turns.",
		plan: "Ask the stronger advisor model for a plan (task, project skills, AGENTS.md, repo map, your exploration findings). Call it after exploring and before writing code. The plan is pinned into every request; afterwards your context is reset to task + plan + last turns.",
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
				const { r, pack, res } = await runAdvisor(kind, extra, ctx, signal);
				if (!res.ok || !res.reply) {
					r.journal.record("advisor", r.turn, `baton_${kind} failed: ${(res.errors ?? []).join("; ")}`, { raw: res.raw, usage: res.usage, attempts: res.attempts });
					const fallback = res.raw ? `\nRaw advisor reply (unvalidated):\n${clip(res.raw, 8000)}` : "";
					return {
						content: [{ type: "text", text: `Baton ${kind}: advisor call failed (${(res.errors ?? ["unknown"]).join("; ")}).${fallback}` }],
						details: { ok: false, packTokens: pack.tokens, attempts: res.attempts, usage: res.usage },
						usage: res.usage as any,
					};
				}
				const plan = renderPlan(res.reply, `baton_${kind}`, res.truncated);
				r.lastPlan = plan;
				r.journal.record("advisor", r.turn, `baton_${kind}: ${res.reply.verdict}`, { ...res.reply, usage: res.usage, attempts: res.attempts, packTokens: pack.tokens });
				r.triggers = onAdvisor(r.triggers, kind, res.reply.verdict, res.reply.plan.length);
				if (res.reply.deferred_rulings?.length && r.deferred.length) {
					r.deferred = resolveDeferred(r.deferred, res.reply.deferred_rulings, "reviewer");
					saveDeferred(r, `deferred rulings from baton_${kind}: ${res.reply.deferred_rulings.map((d) => `${d.id}=${d.ruling}`).join(", ")}`);
				}
				if (res.reply.plan.length && res.reply.verdict !== "done") {
					r.pinned = { reply: res.reply, label: `baton_${kind}` };
					r.stepStatus = {};
				}
				let tail = "";
				if (kind !== "review") {
					const diffStat = (await git(exec, ["diff", "--stat", "HEAD"])) ?? undefined;
					r.pendingReset = { kind, summary: resetSummary({ task: r.userPrompts[0]?.text ?? "", userPrompts: r.userPrompts.map((p) => p.text), plan, diffStat }) };
					tail = "\nYour context will now be reset to the task + this plan + the last turns. Continue with step 1.";
				} else {
					tail = r.triggers.reviewPassed ? "\nReview passed: git commit is allowed." : "\nReview did not pass: fix the steps above, then call baton_review again.";
				}
				return {
					content: [{ type: "text", text: `${plan}${tail}` }],
					details: { ok: true, verdict: res.reply.verdict, packTokens: pack.tokens, model: res.model, attempts: res.attempts, usage: res.usage },
					usage: res.usage as any,
				};
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
					`tool calls ${t.toolCalls}, since advisor ${t.toolCalls - t.lastAdvisorAt}, review passed: ${t.reviewPassed}`,
					`last request: masked ${s.masked}, duplicate ${s.deduped}, stale ${s.stale}, ~${Math.round(s.charsSaved / 2.4)} tok saved`,
					`plan: ${r.pinned ? `${r.pinned.label}, ${Object.values(r.stepStatus).filter((x) => x === "done").length}/${r.pinned.reply.plan.length} steps done` : "none"}`,
					`deferred: ${r.deferred.length ? r.deferred.map((d) => `${d.id} ${d.status} (${d.target})`).join("; ") : "none"}`,
					`advisor ${r.cfg.advisor}, judge ${r.cfg.judge.enabled ? r.cfg.judge.model : "off"}`,
				].join("\n"),
				"info",
			);
		},
	});
}

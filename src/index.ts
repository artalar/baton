/**
 * Baton for pi: deterministic tool journal, output masking, one-shot advisor tools
 * (baton_review / baton_help / baton_plan), context reset and safety triggers.
 */
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AdvisorResult, callAdvisor } from "./advisor.ts";
import { type BatonConfig, loadConfig } from "./config.ts";
import { Journal, type JournalEvent, eventLine } from "./journal.ts";
import { filterEvents, type JudgeProvider } from "./judge.ts";
import { jevJudge } from "./judge-jev.ts";
import { maskMessages, type MsgLike } from "./mask.ts";
import { type AdvisorKind, buildPack, type PackInput, type VerbatimCall } from "./pack.ts";
import { autoCompactSummary, pickFirstKept, resetSummary } from "./reset.ts";
import { changedFiles, type Exec, git, readAgentsMd, repoMap } from "./repo.ts";
import { renderPlan } from "./schema.ts";
import { commitGate, evaluate, initialTriggerState, onAdvisor, onToolResult, type TriggerState } from "./triggers.ts";
import { clip } from "./util.ts";

export const SYSTEM_SNIPPET = `Baton is active. Tool outputs you have already seen are replaced by stubs like "[baton: output masked. evt#12 …]"; call baton_recall({"evt":12}) when you need the full text again.
Use the advisor tools (a stronger model, one call each, costly — do not spam):
- baton_plan: at the start of a non-trivial task, or when the context is getting long. Resets your context to task + plan.
- baton_help: when stuck — the same error twice, or you do not understand a failure. Give your hypothesis, what you tried, and important evt numbers. Resets your context to task + plan.
- baton_review: when you believe a milestone or the task is done, and always before git commit. Its plan is appended; follow it.`;

interface Runtime {
	cfg: BatonConfig;
	journal: Journal;
	triggers: TriggerState;
	turn: number;
	userPrompts: { evt: number; text: string }[];
	lastPlan?: string;
	pendingReset?: { summary: string; kind: AdvisorKind };
	pendingNudge?: string;
	maskStats: { masked: number; deduped: number; stale: number; charsSaved: number };
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
			maskStats: { masked: 0, deduped: 0, stale: 0, charsSaved: 0 },
		};
		rt.userPrompts = rt.journal.events.filter((e) => e.kind === "user_prompt").map((e) => ({ evt: e.evt, text: e.text ?? "" }));
		return rt;
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
		r.triggers = onToolResult(r.triggers, e.toolName, ev.errSig, (ev.filesWritten?.length ?? 0) > 0);
		const usage = ctx.getContextUsage();
		const ratio = usage && usage.tokens !== null && usage.contextWindow ? usage.tokens / usage.contextWindow : null;
		const { nudge, state } = evaluate(r.triggers, r.cfg.triggers, ratio);
		r.triggers = state;
		if (nudge) r.pendingNudge = nudge.message;
		return undefined;
	});

	// Mask outputs in the outgoing request only (session stays complete).
	pi.on("context", (e, ctx) => {
		const r = init(ctx);
		const { messages, stats } = maskMessages(e.messages as unknown as MsgLike[], (id) => r.journal.forCall(id), { ...r.cfg.mask, cwd: ctx.cwd });
		r.maskStats = stats;
		return { messages: messages as unknown as typeof e.messages };
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

	const verbatim = (r: Runtime, e: JournalEvent, maxChars = 6000): VerbatimCall => ({
		event: e,
		args: e.argsDigest ?? "",
		output: clip(r.journal.raw(e.evt) ?? `${e.outHead ?? ""}\n${e.outTail ?? ""}`, maxChars),
	});

	async function runAdvisor(kind: AdvisorKind, extra: Partial<PackInput>, ctx: ExtensionContext, signal?: AbortSignal) {
		const r = init(ctx);
		const task = r.userPrompts[0]?.text ?? "";
		const base: PackInput = { kind, task, userPrompts: r.userPrompts, previousPlan: r.lastPlan, ...extra };
		const tools = r.journal.toolEvents();

		if (kind === "review") {
			base.diffStat = (await git(exec, ["diff", "--stat", "HEAD"])) ?? (await git(exec, ["diff", "--stat"]));
			base.diff = (await git(exec, ["diff", "HEAD"])) ?? (await git(exec, ["diff"])) ?? "";
			base.changedFiles = await changedFiles(exec, ctx.cwd);
			const lt = [...tools].reverse().find((e) => e.test);
			if (lt) base.lastTest = verbatim(r, lt, 8000);
			base.previousPlan = undefined; // review sees only the artefacts
		} else if (kind === "help") {
			base.diffStat = (await git(exec, ["diff", "--stat", "HEAD"])) ?? undefined;
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
			base.agentsMd = readAgentsMd(ctx.cwd);
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

		const pack = buildPack(base, r.cfg.packBudgetTokens);
		r.journal.record("note", r.turn, `baton_${kind} pack built: ${pack.tokens} tok`, { sections: pack.sections });
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
		plan: "Ask the stronger advisor model for a plan (task, AGENTS.md, repo map). Afterwards your context is reset to task + plan + last turns.",
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
				r.triggers = onAdvisor(r.triggers, kind, res.reply.verdict);
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
		description: "Baton status | reset (compact to task + last plan now)",
		handler: async (args, ctx) => {
			const r = init(ctx);
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
					`last request: masked ${s.masked}, duplicate ${s.deduped}, stale ${s.stale}, ~${Math.round(s.charsSaved / 4)} tok saved`,
					`advisor ${r.cfg.advisor}, judge ${r.cfg.judge.enabled ? r.cfg.judge.model : "off"}`,
				].join("\n"),
				"info",
			);
		},
	});
}

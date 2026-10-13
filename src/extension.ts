import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addUsage, type BudgetLevel, budgetLevel, type CostRow, spendOf, type Usage } from "./budget.ts";
import { describeCall, isEdit, isReadOnly, type ToolCall, type ToolOutput } from "./calls.ts";
import { detectChecks, runChecks } from "./checks.ts";
import { type BatonConfig, isSameModel, loadConfig, parseModelRef } from "./config.ts";
import { type ContextMessage, HELPER_INSTRUCTION_TYPE, LEAD_NOTE_TYPE, viewFor } from "./context.ts";
import { decisionState, MORE_CALLS_QUESTION, recordTurn, type TurnRecord } from "./decision.ts";
import { changedPaths, rollbackRun, snapshotTree, treeDiff } from "./git.ts";
import { guardHelperCall } from "./guard.ts";
import { decide } from "./jev.ts";
import { type Journal, openJournal } from "./journal.ts";
import { helperInstruction, LEAD_SYSTEM_NOTE, renderBudgetNote, renderFinalChecksNote, renderRollbackResult, renderRunNote, type RunFacts } from "./notes.ts";
import { type FinishedRun, recordHelperTurn, runStopReason, type SpeculativeRun, speculationDecision, startRun } from "./run.ts";

interface TaskState {
	prompt: string;
	startTree?: string;
	activeRun?: SpeculativeRun;
	cooldownLeft: number;
	recentTurns: TurnRecord[];
	blockedReasons: Map<string, string>;
	finalCheckRounds: number;
	lastGreenTree?: string;
	changedSinceGreen: boolean;
	budgetNoticeSent: boolean;
}

interface SessionStats {
	runs: number;
	skipped: number;
	helperTurns: number;
	helperCalls: number;
	blockedCalls: number;
	rollbacks: number;
	finalCheckRounds: number;
	stopReasons: Record<string, number>;
	jevCalls: number;
	jevFailures: number;
}

type MessageBlock = { type: string; id?: string; name?: string; arguments?: Record<string, unknown>; text?: string };

const MAX_OUTPUT_CHARS = 200_000;

const textOf = (content: unknown) =>
	((Array.isArray(content) ? content : []) as MessageBlock[])
		.flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
		.join("\n");

const emptyStats = (): SessionStats => ({ runs: 0, skipped: 0, helperTurns: 0, helperCalls: 0, blockedCalls: 0, rollbacks: 0, finalCheckRounds: 0, stopReasons: {}, jevCalls: 0, jevFailures: 0 });

const stopReasonKey = (reason: string) => reason.replace(/\(.*$|:.*$|\d+/g, "").trim();

export default function baton(pi: ExtensionAPI) {
	let config: BatonConfig | undefined;
	let journal: Journal | undefined;
	let cwd = "";
	let costs: Record<string, CostRow> = {};
	let jevSpentUsd = 0;
	let budgetExhausted = false;
	let task: TaskState | undefined;
	let runCounter = 0;
	let finishedRuns: FinishedRun[] = [];
	let stats = emptyStats();
	let startedAt = Date.now();

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" = "info") => {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	};

	const init = (ctx: ExtensionContext) => {
		if (config) return;
		const warn = (message: string) => (ctx.hasUI ? ctx.ui.notify(message, "warning") : console.warn(message));
		cwd = ctx.cwd;
		config = loadConfig(cwd, warn);
		const journalRoot = isAbsolute(config.journalDir) ? config.journalDir : join(cwd, config.journalDir);
		journal = openJournal(journalRoot, ctx.sessionManager?.getSessionId?.());
		journal.log("session", { lead: config.lead, helper: config.helper, config });
	};

	const spend = () => spendOf(costs, config!.helper, config!.budget.helperCostFactor, jevSpentUsd);
	const currentBudget = (): BudgetLevel => budgetLevel(spend(), config!.budget.usd, config!.budget.reserveUsd);

	const switchModel = async (ctx: ExtensionContext, role: "lead" | "helper"): Promise<boolean> => {
		const reference = role === "lead" ? config!.lead : config!.helper;
		const parsed = parseModelRef(reference);
		const model = parsed && ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (!model) {
			journal?.log("error", { message: `model not found: ${reference}` });
			notify(ctx, `Baton: model ${reference} is not available in pi's model registry`, "warning");
			return false;
		}
		if (ctx.model?.id === model.id && ctx.model?.provider === model.provider) return true;
		return pi.setModel(model);
	};

	const writeSummary = () => {
		if (!config || !journal) return;
		journal.writeSummary({ lead: config.lead, helper: config.helper, wallSeconds: Math.round((Date.now() - startedAt) / 1000), spend: spend(), budgetUsd: config.budget.usd, budgetExhausted, costs, stats, runs: finishedRuns });
	};

	const leadMessage = (text: string): SessionBoundaryDraft => ({ type: "custom_message", customType: LEAD_NOTE_TYPE, content: text, display: true });

	const askJev = async (latestLeadTurn: TurnRecord, signal: AbortSignal | undefined): Promise<number | undefined> => {
		const jev = config!.jev;
		const earlierTurns = task!.recentTurns.slice(0, -1).slice(-jev.recentTurns);
		const result = await decide(decisionState(task!.prompt, earlierTurns, latestLeadTurn), MORE_CALLS_QUESTION, { model: jev.model, fallbackModel: jev.fallbackModel, timeoutMs: jev.timeoutMs, signal });
		if (!result.ok) {
			stats.jevFailures++;
			jevSpentUsd += result.cost;
			journal?.log("jev", { ok: false, error: result.error.slice(0, 300), latencyMs: Math.round(result.latMs) });
			return undefined;
		}
		stats.jevCalls++;
		jevSpentUsd += result.usage.cost ?? 0;
		const answer = result.answers.more_calls;
		const probability = answer?.type === "noul" ? answer.noul : undefined;
		journal?.log("jev", { ok: true, probability, model: result.model, cached: result.cached, latencyMs: Math.round(result.latMs), cost: result.usage.cost ?? 0 });
		return probability;
	};

	const collectRunFacts = async (run: SpeculativeRun, stopReason: string): Promise<{ facts: RunFacts; endTree?: string; changedFiles: string[] }> => {
		const facts: RunFacts = { stopReason };
		let endTree: string | undefined;
		let filesChanged: boolean;
		if (run.checkpoint.tree) {
			const end = snapshotTree(cwd);
			if ("tree" in end) {
				endTree = end.tree;
				try {
					facts.changedFiles = changedPaths(cwd, run.checkpoint.tree, end.tree);
					facts.diff = facts.changedFiles.length ? treeDiff(cwd, run.checkpoint.tree, end.tree) : "";
				} catch (error) {
					facts.diffUnavailableReason = `git diff failed: ${(error as Error).message.split("\n")[0]}`;
				}
			} else facts.diffUnavailableReason = `the end-of-run snapshot failed: ${end.error}`;
		} else facts.diffUnavailableReason = `no checkpoint (${run.checkpoint.unavailableReason ?? "unavailable"})`;
		if (facts.changedFiles) filesChanged = facts.changedFiles.length > 0;
		else filesChanged = run.calls.some(({ call, blockedReason }) => !blockedReason && (isEdit(call) || (call.name === "bash" && !isReadOnly(call))));

		if (!config!.checks.afterRun) facts.checksSkippedReason = "checks after runs are off";
		else if (!filesChanged) facts.checksSkippedReason = "the run changed no files";
		else {
			const commands = detectChecks(cwd, config!.checks.commands);
			if (commands.length) facts.checks = await runChecks(cwd, commands, config!.checks.timeoutMs);
			else facts.checks = [];
		}
		return { facts, endTree, changedFiles: (facts.changedFiles ?? []).map((file) => file.path) };
	};

	const finishRun = async (ctx: ExtensionContext, stopReason: string): Promise<string> => {
		const run = task!.activeRun!;
		const { facts, endTree, changedFiles } = await collectRunFacts(run, stopReason);
		const note = renderRunNote(run, facts, config!, endTree);
		finishedRuns.push({ number: run.number, startTree: run.checkpoint.tree, endTree, stopReason, steps: run.steps, callCount: run.calls.length, changedFiles });
		stats.stopReasons[stopReasonKey(stopReason)] = (stats.stopReasons[stopReasonKey(stopReason)] ?? 0) + 1;
		const checksPassed = facts.checks?.length ? facts.checks.every((check) => check.passed) : false;
		if (checksPassed && endTree) {
			task!.lastGreenTree = endTree;
			task!.changedSinceGreen = false;
		}
		task!.activeRun = undefined;
		task!.cooldownLeft = config!.cooldown;
		journal?.log("run_end", { run: run.number, stopReason, steps: run.steps, calls: run.calls.length, changedFiles, checks: facts.checks?.map((check) => ({ kind: check.kind, passed: check.passed, ms: check.durationMs })), noteChars: note.length });
		await switchModel(ctx, "lead");
		writeSummary();
		return note;
	};

	const finalVerification = async (ctx: ExtensionContext) => {
		const checksConfig = config!.checks;
		if (!checksConfig.final || task!.finalCheckRounds >= checksConfig.maxFinalRounds) return undefined;
		const snapshot = snapshotTree(cwd);
		const currentTree = "tree" in snapshot ? snapshot.tree : undefined;
		const changed = currentTree && task!.startTree ? currentTree !== task!.startTree && currentTree !== task!.lastGreenTree : task!.changedSinceGreen;
		if (!changed) return undefined;
		const commands = detectChecks(cwd, checksConfig.commands);
		if (!commands.length) return undefined;
		const results = await runChecks(cwd, commands, checksConfig.timeoutMs);
		const passed = results.every((result) => result.passed);
		journal?.log("final_checks", { passed, round: task!.finalCheckRounds + 1, checks: results.map((result) => ({ kind: result.kind, passed: result.passed, ms: result.durationMs })) });
		if (passed) {
			task!.lastGreenTree = currentTree;
			task!.changedSinceGreen = false;
			notify(ctx, "Baton: final checks passed");
			return undefined;
		}
		task!.finalCheckRounds++;
		stats.finalCheckRounds++;
		writeSummary();
		return { entries: [leadMessage(renderFinalChecksNote(results, task!.finalCheckRounds, checksConfig.maxFinalRounds))], continue: true };
	};

	pi.on("session_start", (_event, ctx) => {
		config = undefined;
		task = undefined;
		runCounter = 0;
		finishedRuns = [];
		stats = emptyStats();
		startedAt = Date.now();
		init(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		init(ctx);
		if (budgetExhausted) {
			notify(ctx, `Baton: the budget of $${config!.budget.usd} is spent; this prompt was not run.`, "warning");
			ctx.abort();
			return undefined;
		}
		const interruptedRunNote = task?.activeRun ? await finishRun(ctx, "a new prompt arrived") : undefined;
		if (event.messageType === "user" || !task) {
			const start = config!.checkpoints || config!.checks.final ? snapshotTree(cwd) : undefined;
			task = {
				prompt: event.messageType === "user" ? event.prompt : (task?.prompt ?? ""),
				startTree: start && "tree" in start ? start.tree : undefined,
				cooldownLeft: 0,
				recentTurns: [],
				blockedReasons: new Map(),
				finalCheckRounds: 0,
				changedSinceGreen: false,
				budgetNoticeSent: false,
			};
			journal?.log("task", { prompt: task.prompt.slice(0, 400), startTree: task.startTree });
		}
		await switchModel(ctx, "lead");
		const systemPrompt = event.systemPrompt + LEAD_SYSTEM_NOTE;
		if (!interruptedRunNote) return { systemPrompt };
		return { systemPrompt, message: { customType: LEAD_NOTE_TYPE, content: interruptedRunNote, display: true } };
	});

	pi.on("tool_call", (event) => {
		const run = task?.activeRun;
		if (!run || !config || event.parentToolCallId) return undefined;
		const call: ToolCall = { id: event.toolCallId, name: event.toolName, args: (event.input ?? {}) as Record<string, unknown> };
		const alreadyBlocked = task!.blockedReasons.size > 0;
		const absolute = (path: string) => (isAbsolute(path) ? path : join(cwd, path));
		const reason = alreadyBlocked
			? "the run already ended after a blocked call"
			: config.guardrails
				? guardHelperCall(call, {
						fileExists: (path) => existsSync(absolute(path)),
						readFile: (path) => {
							try {
								return readFileSync(absolute(path), "utf8");
							} catch {
								return undefined;
							}
						},
					})
				: undefined;
		if (!reason) return undefined;
		task!.blockedReasons.set(call.id, reason);
		stats.blockedCalls++;
		journal?.log("blocked", { run: run.number, call: describeCall(call), reason });
		return { block: true, reason: `Baton: this call is not allowed for the helper (${reason}). The speculative run ends here and the lead model takes over. Reply with one short line and no tool call.` };
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as { role?: string; model?: string; usage?: Usage };
		if (message.role !== "assistant" || !config) return undefined;
		costs = addUsage(costs, message.model ?? "unknown", message.usage);
		journal?.log("usage", { model: message.model, cost: message.usage?.cost?.total ?? 0, input: message.usage?.input, output: message.usage?.output, cacheRead: message.usage?.cacheRead, cacheWrite: message.usage?.cacheWrite });
		if (!budgetExhausted && currentBudget() === "exhausted") {
			budgetExhausted = true;
			journal?.log("budget_exhausted", { spend: spend(), budgetUsd: config.budget.usd });
			writeSummary();
			notify(ctx, `Baton: budget stop — about $${spend().total.toFixed(2)} of $${config.budget.usd} spent.`, "warning");
			ctx.abort();
		}
		return undefined;
	});

	pi.on("context", (event) => {
		if (!config) return undefined;
		return { messages: viewFor(event.messages as unknown as ContextMessage[], config.helper, task?.activeRun?.startedAt) as unknown as typeof event.messages };
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!config || !task) return undefined;
		const message = event.message as { role?: string; content?: MessageBlock[]; stopReason?: string; errorMessage?: string; model?: string };
		if (message.role !== "assistant") return undefined;
		const blocks = Array.isArray(message.content) ? message.content : [];
		const calls: ToolCall[] = blocks.filter((block) => block.type === "toolCall" && block.id).map((block) => ({ id: block.id!, name: block.name ?? "", args: block.arguments ?? {} }));
		const outputs: ToolOutput[] = event.toolResults.map((result) => ({ id: result.toolCallId, isError: !!result.isError, text: textOf(result.content).slice(0, MAX_OUTPUT_CHARS) }));
		const run = task.activeRun;
		if (calls.some((call) => isEdit(call) || (call.name === "bash" && !isReadOnly(call)))) task.changedSinceGreen = true;

		if (run) {
			recordHelperTurn(run, calls, outputs, task.blockedReasons);
			stats.helperTurns++;
			stats.helperCalls += calls.length;
			task.recentTurns.push(recordTurn("helper", calls, outputs, config.jev.clipChars));
			if (message.stopReason === "aborted") {
				const note = await finishRun(ctx, "the user interrupted it");
				return { entries: [leadMessage(note)] };
			}
			const budget = currentBudget();
			const stopReason = runStopReason(run, config, { now: Date.now(), turnHadToolCalls: calls.length > 0, turnFailed: message.stopReason === "error" ? message.errorMessage || "error" : undefined, budget });
			if (!stopReason) return undefined;
			const entries = [leadMessage(await finishRun(ctx, stopReason))];
			if (budget === "wrapUp" && !task.budgetNoticeSent) {
				task.budgetNoticeSent = true;
				entries.push(leadMessage(renderBudgetNote(spend().total, config.budget.usd)));
			}
			return { entries, continue: true };
		}

		if (isSameModel(message.model, config.helper)) return undefined;
		if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
		const leadTurn = recordTurn("lead", calls, outputs, config.jev.clipChars);
		task.recentTurns.push(leadTurn);
		task.recentTurns = task.recentTurns.slice(-(config.jev.recentTurns + 1));
		if (!calls.length) return finalVerification(ctx);

		const entries: SessionBoundaryDraft[] = [];
		const budget = currentBudget();
		if (budget === "wrapUp" && !task.budgetNoticeSent) {
			task.budgetNoticeSent = true;
			entries.push(leadMessage(renderBudgetNote(spend().total, config.budget.usd)));
		}
		const mayAskJev = config.speculate && config.jev.enabled && task.cooldownLeft === 0 && (budget === "ok" || budget === "unlimited");
		const probability = mayAskJev ? await askJev(leadTurn, ctx.signal) : undefined;
		const decision = speculationDecision({ leadCalls: calls, cooldownLeft: task.cooldownLeft, budget, probability }, config);
		if (task.cooldownLeft > 0) task.cooldownLeft--;
		journal?.log("decision", { start: decision.start, reason: decision.reason });
		if (!decision.start) {
			stats.skipped++;
			return entries.length ? { entries } : undefined;
		}

		const snapshot = config.checkpoints ? snapshotTree(cwd) : undefined;
		const checkpoint = !snapshot ? { unavailableReason: "checkpoints are off" } : "tree" in snapshot ? { tree: snapshot.tree } : { unavailableReason: snapshot.error };
		const nextRun = startRun(runCounter + 1, Date.now(), config, checkpoint, probability);
		if (!(await switchModel(ctx, "helper"))) return entries.length ? { entries } : undefined;
		runCounter = nextRun.number;
		stats.runs++;
		task.activeRun = nextRun;
		task.blockedReasons = new Map();
		journal?.log("run_start", { run: nextRun.number, reason: decision.reason, checkpoint: checkpoint.tree, checkpointError: checkpoint.unavailableReason });
		entries.push({ type: "custom_message", customType: HELPER_INSTRUCTION_TYPE, content: helperInstruction(nextRun, calls.map((call) => describeCall(call, 120))), display: true });
		return { entries };
	});

	pi.on("agent_end", () => {
		writeSummary();
	});

	pi.registerTool({
		name: "baton_rollback",
		label: "Baton rollback",
		description:
			"Undo one speculative run of the helper model: every file the run changed goes back to the checkpoint taken before the run, and files it created are deleted. Files changed again after the run are left as they are. Defaults to the latest run.",
		parameters: Type.Object({ run: Type.Optional(Type.Number({ description: "The run number from the harness note (default: the latest run)." })) }),
		async execute(_toolCallId, params) {
			const target = params.run === undefined ? finishedRuns.at(-1) : finishedRuns.find((run) => run.number === params.run);
			const reply = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });
			if (!target) return reply(params.run === undefined ? "baton_rollback: there is no finished speculative run." : `baton_rollback: there is no run #${params.run}.`);
			if (!target.startTree || !target.endTree) return reply(`baton_rollback: run #${target.number} has no checkpoint, so it cannot be rolled back.`);
			if (target.rolledBack) return reply(`baton_rollback: run #${target.number} was already rolled back.`);
			const result = rollbackRun(cwd, target.startTree, target.endTree);
			if (!result.error) {
				target.rolledBack = true;
				stats.rollbacks++;
			}
			journal?.log("rollback", { run: target.number, ...result });
			writeSummary();
			return reply(renderRollbackResult(target, result), { run: target.number, ...result });
		},
	});
}

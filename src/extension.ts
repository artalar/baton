import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type BatonConfig, FIRST_RUN_MAX_TURNS, isSameModel, loadConfig, parseModelRef } from "./config.ts";
import { type ContextMessage, HELPER_INSTRUCTION_TYPE, LEAD_NOTE_TYPE, viewFor } from "./context.ts";
import { type Journal, openJournal } from "./journal.ts";
import { keepWarm, type SentRequest } from "./keepalive.ts";
import { describeCall, helperInstruction, LEAD_SYSTEM_NOTE, renderRunNote, renderUndoResult } from "./notes.ts";
import { type ActiveRun, collectChanges, type FinishedRun, type RunCall, recordTurn, rememberOriginal, startRun, undoRun } from "./run.ts";

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

interface CostRow {
	requests: number;
	usd: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

interface SessionStats {
	runs: number;
	helperTurns: number;
	helperCalls: number;
	undos: number;
	cacheKeepalives: number;
	stopReasons: Record<string, number>;
}

type MessageBlock = { type: string; id?: string; name?: string; arguments?: Record<string, unknown>; text?: string };

const MAX_OUTPUT_CHARS = 200_000;
const UNDO_TOOL = "baton_undo";

const textOf = (content: unknown) =>
	((Array.isArray(content) ? content : []) as MessageBlock[])
		.flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
		.join("\n");

const emptyStats = (): SessionStats => ({ runs: 0, helperTurns: 0, helperCalls: 0, undos: 0, cacheKeepalives: 0, stopReasons: {} });

const stopReasonKey = (reason: string) => reason.replace(/\s*\(.*$/, "").replace(/\d+/g, "N");

export default function baton(pi: ExtensionAPI) {
	let config: BatonConfig | undefined;
	let journal: Journal | undefined;
	let cwd = "";
	let activeRun: ActiveRun | undefined;
	let finishedRuns: FinishedRun[] = [];
	let runCounter = 0;
	let costs: Record<string, CostRow> = {};
	let stats = emptyStats();
	let startedAt = Date.now();
	let lastLeadRequest: SentRequest | undefined;
	let stopKeepalive = () => {};

	const notify = (ctx: ExtensionContext, message: string) => {
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else console.warn(message);
	};

	const init = (ctx: ExtensionContext) => {
		if (config) return;
		cwd = ctx.cwd;
		config = loadConfig(cwd, (message) => notify(ctx, message));
		const journalRoot = isAbsolute(config.journalDir) ? config.journalDir : join(cwd, config.journalDir);
		journal = openJournal(journalRoot, ctx.sessionManager?.getSessionId?.());
		journal.log("session", { config });
	};

	const switchModel = async (ctx: ExtensionContext, role: "lead" | "helper"): Promise<boolean> => {
		const reference = role === "lead" ? config!.lead : config!.helper;
		const parsed = parseModelRef(reference);
		const model = parsed && ctx.modelRegistry.find(parsed.provider, parsed.id);
		if (!model) {
			journal?.log("error", { message: `model not found: ${reference}` });
			notify(ctx, `Baton: model ${reference} is not available in pi's model registry`);
			return false;
		}
		if (ctx.model?.id === model.id && ctx.model?.provider === model.provider) return true;
		return pi.setModel(model);
	};

	const writeSummary = () => {
		if (!config || !journal) return;
		const runs = finishedRuns.map((run) => ({ number: run.number, stopReason: run.stopReason, turns: run.turns, calls: run.callCount, changedFiles: run.changes.map((change) => change.path), undone: [...run.undone] }));
		journal.writeSummary({ lead: config.lead, helper: config.helper, wallSeconds: Math.round((Date.now() - startedAt) / 1000), costs, stats, runs });
	};

	const leadNote = (text: string): SessionBoundaryDraft => ({ type: "custom_message", customType: LEAD_NOTE_TYPE, content: text, display: true });

	const addUsage = (model: string, usage: Usage) => {
		const row = costs[model] ?? { requests: 0, usd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		costs[model] = {
			requests: row.requests + 1,
			usd: row.usd + (usage.cost?.total ?? 0),
			input: row.input + (usage.input ?? 0),
			output: row.output + (usage.output ?? 0),
			cacheRead: row.cacheRead + (usage.cacheRead ?? 0),
			cacheWrite: row.cacheWrite + (usage.cacheWrite ?? 0),
		};
	};

	const startKeepalive = (ctx: ExtensionContext, leadUsage: Usage | undefined) => {
		const request = lastLeadRequest;
		const leadUsedPromptCache = (leadUsage?.cacheRead ?? 0) + (leadUsage?.cacheWrite ?? 0) > 0;
		if (!request || !leadUsedPromptCache) return;
		const runNumber = runCounter;
		stopKeepalive = keepWarm(request, config!.cacheKeepaliveMs, ctx.modelRegistry, ({ sincePreviousMs, error, usage }) => {
			stats.cacheKeepalives++;
			if (usage) addUsage(request.model.id, usage);
			journal?.log("cache_keepalive", { run: runNumber, model: request.model.id, sincePreviousMs, error, cost: usage?.cost?.total, input: usage?.input, output: usage?.output, cacheRead: usage?.cacheRead, cacheWrite: usage?.cacheWrite });
			writeSummary();
		});
	};

	const finishRun = async (ctx: ExtensionContext, stopReason: string): Promise<string> => {
		const run = activeRun!;
		activeRun = undefined;
		stopKeepalive();
		const changes = collectChanges(run, cwd);
		const note = renderRunNote({ runNumber: run.number, helperModel: config!.helper, stopReason, turns: run.turns, calls: run.calls, changes, noteChars: config!.noteChars });
		finishedRuns.push({ number: run.number, stopReason, turns: run.turns, callCount: run.calls.length, changes, undone: new Set() });
		const reasonKey = stopReasonKey(stopReason);
		stats.stopReasons[reasonKey] = (stats.stopReasons[reasonKey] ?? 0) + 1;
		journal?.log("run_end", { run: run.number, stopReason, turns: run.turns, calls: run.calls.length, changedFiles: changes.map((change) => change.path), noteChars: note.length });
		await switchModel(ctx, "lead");
		writeSummary();
		return note;
	};

	pi.on("session_start", (_event, ctx) => {
		stopKeepalive();
		config = undefined;
		activeRun = undefined;
		finishedRuns = [];
		runCounter = 0;
		costs = {};
		stats = emptyStats();
		startedAt = Date.now();
		lastLeadRequest = undefined;
		init(ctx);
	});

	pi.on("session_shutdown", () => {
		stopKeepalive();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		init(ctx);
		const interruptedRunNote = activeRun ? await finishRun(ctx, "a new prompt arrived") : undefined;
		if (event.messageType === "user") journal?.log("prompt", { prompt: event.prompt.slice(0, 400) });
		await switchModel(ctx, "lead");
		const systemPrompt = event.systemPrompt + LEAD_SYSTEM_NOTE;
		if (!interruptedRunNote) return { systemPrompt };
		return { systemPrompt, message: { customType: LEAD_NOTE_TYPE, content: interruptedRunNote, display: true } };
	});

	pi.on("tool_call", (event) => {
		if (!activeRun) return undefined;
		if (activeRun.stopRequested) return { block: true, terminate: true, reason: "Baton: the lead model takes over now. Reply with one short line and no tool call." };
		rememberOriginal(activeRun, cwd, { name: event.toolName, args: (event.input ?? {}) as Record<string, unknown> });
		return undefined;
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; model?: string; usage?: Usage };
		if (!config) return undefined;
		if (message.role === "user" && activeRun) activeRun.stopRequested = "the user sent a message";
		if (message.role !== "assistant") return undefined;
		const model = message.model ?? "unknown";
		const usage = message.usage ?? {};
		addUsage(model, usage);
		journal?.log("usage", { model, run: activeRun?.number, cost: usage.cost?.total ?? 0, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
		return undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!config?.speculate || !config.cacheKeepaliveMs || activeRun || !ctx.model) return undefined;
		lastLeadRequest = undefined;
		try {
			lastLeadRequest = { model: ctx.model, payload: structuredClone(event.payload), sessionId: ctx.sessionManager?.getSessionId?.(), sentAt: Date.now() };
		} catch (error) {
			journal?.log("error", { message: `cache keepalive: cannot copy the lead request: ${(error as Error).message}` });
		}
		return undefined;
	});

	pi.on("context", (event) => {
		if (!config) return undefined;
		return { messages: viewFor(event.messages as unknown as ContextMessage[], config.helper, activeRun?.startedAt) as unknown as typeof event.messages };
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!config) return undefined;
		const message = event.message as { role?: string; content?: MessageBlock[]; stopReason?: string; errorMessage?: string; model?: string; usage?: Usage };
		if (message.role !== "assistant") return undefined;
		const blocks = Array.isArray(message.content) ? message.content : [];
		const results = new Map(event.toolResults.map((result) => [result.toolCallId, result]));
		const calls: RunCall[] = blocks
			.filter((block) => block.type === "toolCall" && block.id)
			.map((block) => {
				const result = results.get(block.id!);
				return { id: block.id!, name: block.name ?? "", args: block.arguments ?? {}, isError: result?.isError, output: result ? textOf(result.content).slice(0, MAX_OUTPUT_CHARS) : undefined };
			});

		if (activeRun) {
			recordTurn(activeRun, calls);
			stats.helperTurns++;
			stats.helperCalls += calls.length;
			if (message.stopReason === "aborted") return { entries: [leadNote(await finishRun(ctx, "the user interrupted it"))] };
			const maxTurns = activeRun.number === 1 ? Math.min(config.maxHelperTurns, FIRST_RUN_MAX_TURNS) : config.maxHelperTurns;
			const stopReason =
				message.stopReason === "error"
					? `the helper's request failed (${oneLineError(message.errorMessage)})`
					: activeRun.stopRequested
						? activeRun.stopRequested
						: !calls.length
							? "the helper ended its turn without tool calls"
							: activeRun.turns >= maxTurns
								? `it reached the safety cap of ${maxTurns} helper turns`
								: undefined;
			if (!stopReason) return undefined;
			return { entries: [leadNote(await finishRun(ctx, stopReason))], continue: true };
		}

		if (!config.speculate || isSameModel(message.model, config.helper)) return undefined;
		if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
		if (!calls.length || calls.some((call) => call.name === UNDO_TOOL)) return undefined;
		if (!(await switchModel(ctx, "helper"))) return undefined;
		runCounter++;
		stats.runs++;
		activeRun = startRun(runCounter, Date.now());
		journal?.log("run_start", { run: runCounter, after: calls.map((call) => describeCall(call, 120)) });
		startKeepalive(ctx, message.usage);
		return { entries: [{ type: "custom_message", customType: HELPER_INSTRUCTION_TYPE, content: helperInstruction(runCounter), display: true }] };
	});

	pi.on("agent_end", () => {
		stopKeepalive();
		writeSummary();
	});

	pi.registerTool({
		name: UNDO_TOOL,
		label: "Baton undo",
		description:
			"Undo a speculative run of the helper model: files it changed with edit/write go back to their content before the run, and files it created are deleted. Files changed again after the run are left as they are and listed. Changes the helper made through bash are not covered.",
		parameters: Type.Object({
			run: Type.Number({ description: "Run number from the [Baton] note." }),
			paths: Type.Optional(Type.Array(Type.String(), { description: "Only these files, as listed in the note. Default: every file of the run." })),
		}),
		async execute(_toolCallId, params) {
			const reply = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });
			if (activeRun) return reply("baton_undo: only the lead can undo a run.");
			const target = finishedRuns.find((run) => run.number === params.run);
			if (!target) return reply(`baton_undo: there is no run #${params.run} in this session.`);
			const result = undoRun(target, cwd, params.paths);
			stats.undos++;
			journal?.log("undo", { run: target.number, ...result });
			writeSummary();
			return reply(renderUndoResult(target.number, result), { run: target.number, ...result });
		},
	});
}

const oneLineError = (errorMessage: string | undefined) => (errorMessage ?? "error").replace(/\s+/g, " ").slice(0, 200);

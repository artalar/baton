import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { type BatonConfig, FIRST_RUN_MAX_TURNS, isSameModel, loadConfig, parseModelRef, type ThinkingLevel } from "./config.ts";
import { ALERT_TYPE, type ContextMessage, projectSystemPrompt, viewFor } from "./context.ts";
import { type Journal, openJournal } from "./journal.ts";
import { keepWarm, type SentRequest } from "./keepalive.ts";
import { followerSystemNote, leadSystemNote, renderAlert } from "./notes.ts";
import { type ActiveRun, type FinishedRun, recordTurn, type RunCall, startRun } from "./run.ts";

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
	cacheKeepalives: number;
	stopReasons: Record<string, number>;
}

type MessageBlock = { type: string; id?: string; name?: string; arguments?: Record<string, unknown>; text?: string };

const MAX_OUTPUT_CHARS = 200_000;
const OUTPUT_CUT_MARKER = "\n[output cut]";

const textOf = (content: unknown) =>
	((Array.isArray(content) ? content : []) as MessageBlock[])
		.flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
		.join("\n");

const outputWithinLimit = (text: string) => (text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}${OUTPUT_CUT_MARKER}` : text);

const emptyStats = (): SessionStats => ({ runs: 0, helperTurns: 0, helperCalls: 0, cacheKeepalives: 0, stopReasons: {} });

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
	/** The lead's thinking level while the follower runs with its own. */
	let leadThinking: ThinkingLevel | undefined;

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

	/** pi's setModel resets the thinking level to the settings default, so every switch sets it explicitly. */
	const applyThinking = (role: "lead" | "helper", levelBeforeSwitch: ThinkingLevel) => {
		if (role === "lead") {
			pi.setThinkingLevel(leadThinking ?? levelBeforeSwitch);
			leadThinking = undefined;
			return;
		}
		leadThinking = levelBeforeSwitch;
		pi.setThinkingLevel(config!.helperThinking === "inherit" ? levelBeforeSwitch : config!.helperThinking);
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
		const levelBeforeSwitch = pi.getThinkingLevel();
		if (!(await pi.setModel(model))) return false;
		applyThinking(role, levelBeforeSwitch);
		return true;
	};

	const writeSummary = () => {
		if (!config || !journal) return;
		const runs = finishedRuns.map((run) => ({
			number: run.number,
			stopReason: run.stopReason,
			turns: run.turns,
			calls: run.callCount,
		}));
		journal.writeSummary({ lead: config.lead, helper: config.helper, wallSeconds: Math.round((Date.now() - startedAt) / 1000), costs, stats, runs });
	};

	const alertEntry = (text: string): SessionBoundaryDraft => ({ type: "custom_message", customType: ALERT_TYPE, content: text, display: true });

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
		const alert = renderAlert(run.calls);
		finishedRuns.push({ number: run.number, stopReason, turns: run.turns, callCount: run.calls.length });
		const reasonKey = stopReasonKey(stopReason);
		stats.stopReasons[reasonKey] = (stats.stopReasons[reasonKey] ?? 0) + 1;
		journal?.log("run_end", { run: run.number, stopReason, turns: run.turns, calls: run.calls.length });
		await switchModel(ctx, "lead");
		writeSummary();
		return alert;
	};

	const role = (): "lead" | "follower" => (activeRun ? "follower" : "lead");

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
		leadThinking = undefined;
		init(ctx);
	});

	pi.on("session_shutdown", () => {
		stopKeepalive();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		init(ctx);
		const interruptedAlert = activeRun ? await finishRun(ctx, "a new prompt arrived") : undefined;
		if (event.messageType === "user") journal?.log("prompt", { prompt: event.prompt.slice(0, 400) });
		if (!config!.speculate) {
			if (!interruptedAlert) return undefined;
			return { message: { customType: ALERT_TYPE, content: interruptedAlert, display: true } };
		}
		await switchModel(ctx, "lead");
		if (!interruptedAlert) return undefined;
		return { message: { customType: ALERT_TYPE, content: interruptedAlert, display: true } };
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role?: string; model?: string; usage?: Usage };
		if (!config) return undefined;
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
		if (!config?.speculate) return undefined;
		return { messages: viewFor(event.messages as unknown as ContextMessage[], config.helper, role()) as unknown as typeof event.messages };
	});

	pi.on("context_with_system", (event) => {
		if (!config?.speculate) return undefined;
		const note = role() === "follower" ? followerSystemNote() : leadSystemNote();
		return { messages: projectSystemPrompt(event.messages as unknown as ContextMessage[], note) as unknown as typeof event.messages };
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
				return {
					id: block.id!,
					name: block.name ?? "",
					args: block.arguments ?? {},
					isError: result?.isError,
					output: result ? outputWithinLimit(textOf(result.content)) : undefined,
				};
			});

		if (activeRun) {
			recordTurn(activeRun, calls);
			stats.helperTurns++;
			stats.helperCalls += calls.length;
			if (message.stopReason === "aborted") return { entries: [alertEntry(await finishRun(ctx, "the user interrupted it"))] };
			const maxTurns = activeRun.number === 1 ? Math.min(config.maxHelperTurns, FIRST_RUN_MAX_TURNS) : config.maxHelperTurns;
			const stopReason =
				message.stopReason === "error"
					? `the follower's request failed (${oneLineError(message.errorMessage)})`
					: !calls.length
						? "the follower ended its turn without tool calls"
						: activeRun.turns >= maxTurns
							? `it reached the safety cap of ${maxTurns} follower turns`
							: undefined;
			if (!stopReason) return undefined;
			return { entries: [alertEntry(await finishRun(ctx, stopReason))], continue: true };
		}

		if (!config.speculate || isSameModel(message.model, config.helper)) return undefined;
		if (message.stopReason === "error" || message.stopReason === "aborted" || !calls.length) return undefined;
		if (!(await switchModel(ctx, "helper"))) return undefined;
		runCounter++;
		stats.runs++;
		activeRun = startRun(runCounter);
		journal?.log("run_start", { run: runCounter, after: calls.map((call) => call.name) });
		startKeepalive(ctx, message.usage);
		return undefined;
	});

	pi.on("agent_end", () => {
		stopKeepalive();
		writeSummary();
	});
}

const oneLineError = (errorMessage: string | undefined) => (errorMessage ?? "error").replace(/\s+/g, " ").slice(0, 200);

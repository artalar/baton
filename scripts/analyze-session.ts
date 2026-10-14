#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface UsageCost {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	total?: number;
}

export interface TokenUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens?: number;
	cost?: UsageCost;
}

export interface ContentBlock {
	type: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	text?: string;
	thinking?: string;
}

export interface RawSessionEntry {
	type: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	version?: number;
	cwd?: string;
	name?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	customType?: string;
	content?: string;
	display?: boolean;
	message?: {
		role: string;
		content?: string | ContentBlock[];
		model?: string;
		provider?: string;
		api?: string;
		thinkingLevel?: string;
		providerThinkingLevel?: string;
		usage?: TokenUsage;
		stopReason?: string;
		rawStopReason?: string;
		errorMessage?: string;
		timestamp?: number;
		durationMs?: number;
		responseId?: string;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: Record<string, unknown>;
		sections?: Record<string, string>;
		toolsAdded?: Array<{ name?: string; description?: string }>;
	};
}

export interface ToolCallRecord {
	id: string;
	name: string;
	args: Record<string, unknown>;
	target: string;
	summary: string;
	turnIndex: number;
	model: string;
	role: "lead" | "helper";
	runNumber?: number;
	timestampIso: string;
	durationMs: number;
	isError: boolean;
	outputChars: number;
	outputPreview: string;
	bashCategory?: BashCategory;
	bashMutatesFiles?: boolean;
	bashPipedCheck?: boolean;
}

export type BashCategory = "test" | "build-typecheck" | "package-install" | "browser-probe" | "file-mutation" | "search-read" | "other";

export interface AssistantTurnRecord {
	turnIndex: number;
	entryIndex: number;
	model: string;
	provider: string;
	role: "lead" | "helper";
	runNumber?: number;
	thinkingLevel: string;
	stopReason: string;
	errorMessage?: string;
	startedAtMs: number;
	endedAtMs: number;
	timestampIso: string;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	contextTokens: number;
	totalTokens: number;
	outputTokensPerSec: number;
	costInputUsd: number;
	costOutputUsd: number;
	costCacheReadUsd: number;
	costCacheWriteUsd: number;
	costTotalUsd: number;
	thinkingChars: number;
	textChars: number;
	textContent: string;
	toolCalls: ToolCallRecord[];
	toolExecutionMs: number;
}

export interface DistributionStats {
	count: number;
	sum: number;
	min: number;
	avg: number;
	p50: number;
	p90: number;
	p95: number;
	max: number;
}

export interface ModelAggregate {
	model: string;
	role: "lead" | "helper";
	turns: number;
	turnsWithTools: number;
	turnsStopped: number;
	turnsErrored: number;
	toolCalls: number;
	toolErrors: number;
	callsPerTurn: number;
	batchedTurns: number;
	maxCallsInTurn: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	cacheHitRate: number;
	peakContextTokens: number;
	avgContextTokens: number;
	costInputUsd: number;
	costOutputUsd: number;
	costCacheReadUsd: number;
	costCacheWriteUsd: number;
	costTotalUsd: number;
	costShare: number;
	effectiveInputUsdPerM: number;
	effectiveOutputUsdPerM: number;
	thinkingChars: number;
	textChars: number;
	latencyMs: DistributionStats;
	costPerTurnUsd: DistributionStats;
	outputTokensPerSec: DistributionStats;
	keepalivePings: number;
	keepaliveCostUsd: number;
}

export interface NoteFileStat {
	kind: "created" | "modified" | "deleted";
	path: string;
	added: number;
	removed: number;
}

export interface SpeculativeRunRecord {
	runNumber: number;
	helperModel: string;
	startedAtIso: string;
	endedAtIso?: string;
	wallDurationMs: number;
	finished: boolean;
	stopReason: string;
	triggerLeadTurnIndex?: number;
	triggerLeadCalls: string[];
	turns: number;
	toolCalls: number;
	toolErrors: number;
	callsPerTurn: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	contextStartTokens: number;
	contextEndTokens: number;
	thinkingChars: number;
	textChars: number;
	turnLatencyMs: DistributionStats;
	outputTokensPerSec: DistributionStats;
	noteChars?: number;
	noteFiles: NoteFileStat[];
	noteDiffClippedCount: number;
	noteOmittedReadsCount: number;
	noteShownReadsCount: number;
	editedFiles: string[];
	bashMutatedFiles: string[];
	leadFollowupTurnIndex?: number;
	leadGapSincePrevLeadMs?: number;
	leadFollowupCacheReadTokens?: number;
	leadFollowupCacheWriteTokens?: number;
	leadFollowupCostUsd?: number;
	leadReaction: "kept" | "fixed" | "undone" | "unfinished" | "none";
	leadSteeringNote?: string;
}

export interface ToolAggregate {
	name: string;
	totalCalls: number;
	leadCalls: number;
	helperCalls: number;
	errors: number;
	errorRate: number;
	durationMs: DistributionStats;
	totalOutputChars: number;
	avgOutputChars: number;
}

export interface FileHotspot {
	path: string;
	reads: number;
	writes: number;
	edits: number;
	editErrors: number;
	bashMutations: number;
	leadTouches: number;
	helperTouches: number;
	addedLines: number;
	removedLines: number;
}

export interface TimelineSegment {
	kind: "lead-turn" | "helper-run";
	label: string;
	startedAtIso: string;
	durationMs: number;
	turns: number;
	toolCalls: number;
	toolErrors: number;
	costUsd: number;
	contextTokens: number;
	summary: string;
}

export interface DiagnosticFinding {
	severity: "critical" | "warning" | "info";
	category: string;
	message: string;
}

export interface CompanionRunnerStatus {
	name?: string;
	withBaton?: boolean;
	state?: string;
	elapsedSec?: number;
	limitSec?: number;
	budgetUsd?: number;
	totalUsd?: number;
	lastEvent?: string;
	stopReason?: string | null;
	exitCode?: number | null;
	settled?: boolean;
}

export interface CompanionJournalData {
	config?: Record<string, unknown>;
	keepalives: Array<{
		ts: string;
		run?: number;
		model?: string;
		sincePreviousMs?: number;
		error?: string;
		cost?: number;
		cacheRead?: number;
		cacheWrite?: number;
	}>;
	undos: Array<{
		ts: string;
		run: number;
		restored?: string[];
		deleted?: string[];
		changedLater?: string[];
	}>;
}

export interface SessionAnalysis {
	sessionFilePath: string;
	sessionFileBytes: number;
	totalJsonlEntries: number;
	sessionId: string;
	sessionName: string;
	cwd: string;
	startedAtIso: string;
	endedAtIso: string;
	transcriptWallMs: number;
	runnerWallMs?: number;
	leadInferenceMs: number;
	helperInferenceMs: number;
	toolExecutionMs: number;
	unaccountedWallMs: number;
	withBaton: boolean;
	leadModel: string;
	helperModel?: string;
	completedCleanly: boolean;
	terminationSummary: string;
	userPromptPreview: string;
	systemPromptChars: number;
	totalTurns: number;
	leadTurns: number;
	helperTurns: number;
	totalToolCalls: number;
	totalToolErrors: number;
	totalCostUsd: number;
	leadCostUsd: number;
	helperCostUsd: number;
	keepaliveCostUsd: number;
	estimatedSingleModelLeadCostUsd: number;
	estimatedSavingsUsd: number;
	estimatedSavingsRatio: number;
	models: ModelAggregate[];
	runs: SpeculativeRunRecord[];
	tools: ToolAggregate[];
	bashBreakdown: Record<BashCategory, { calls: number; errors: number; pipedChecks: number }>;
	fileHotspots: FileHotspot[];
	timeline: TimelineSegment[];
	slowestTurns: AssistantTurnRecord[];
	slowestToolCalls: ToolCallRecord[];
	diagnostics: DiagnosticFinding[];
	companionRunner?: CompanionRunnerStatus;
	companionJournal?: CompanionJournalData;
	turns: AssistantTurnRecord[];
}

const stripRouterPrefix = (modelName: string | undefined): string => {
	if (!modelName) return "unknown";
	return modelName.startsWith("openrouter/") ? modelName.slice("openrouter/".length) : modelName;
};

const isSameNormalizedModel = (first: string | undefined, second: string | undefined): boolean => {
	if (!first || !second) return false;
	return stripRouterPrefix(first) === stripRouterPrefix(second);
};

const computeDistribution = (values: number[]): DistributionStats => {
	if (values.length === 0) {
		return { count: 0, sum: 0, min: 0, avg: 0, p50: 0, p90: 0, p95: 0, max: 0 };
	}
	const sorted = [...values].sort((left, right) => left - right);
	const sum = sorted.reduce((acc, item) => acc + item, 0);
	const percentile = (ratio: number): number => {
		const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
		return sorted[index]!;
	};
	return {
		count: sorted.length,
		sum,
		min: sorted[0]!,
		avg: sum / sorted.length,
		p50: percentile(0.5),
		p90: percentile(0.9),
		p95: percentile(0.95),
		max: sorted[sorted.length - 1]!,
	};
};

const oneLinePreview = (value: string, maxLength = 100): string => {
	const compact = value.replace(/\s+/g, " ").trim();
	return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
};

const normalizeFilePath = (cwd: string, rawPath: string): string => {
	const cleaned = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	if (!cwd) return cleaned;
	const resolved = resolve(cwd, cleaned);
	const rel = relative(cwd, resolved);
	return rel && !rel.startsWith("..") ? rel : cleaned;
};

const classifyBashCommand = (command: string, cwd: string): { category: BashCategory; mutatesFiles: boolean; mutatedPaths: string[]; pipedCheck: boolean } => {
	const mutatedPaths: string[] = [];
	const sedInPlaceMatches = [...command.matchAll(/\bsed\s+-i(?:\s+''|\s+"")?\s+(?:'[^']*'|"[^"]*"|\S+)\s+([^\s;&|]+)/g)];
	for (const match of sedInPlaceMatches) {
		if (match[1]) mutatedPaths.push(normalizeFilePath(cwd, match[1]));
	}
	const redirectMatches = [...command.matchAll(/(?:cat|echo|printf|tee)\s+(?:>>?|>)\s*([^\s;&|<]+)|>\s*([^\s;&|<]+)\s*<<['"]?\w+/g)];
	for (const match of redirectMatches) {
		const candidate = match[1] ?? match[2];
		if (candidate && !candidate.startsWith("/dev/") && !candidate.startsWith("&") && !candidate.startsWith("/tmp/")) {
			mutatedPaths.push(normalizeFilePath(cwd, candidate));
		}
	}
	const mutatesFiles =
		mutatedPaths.length > 0 ||
		/\bsed\s+-i\b|\bwriteFileSync\b|\.write_text\(|\bopen\([^)]*['"]w['"]|\brm\s+-[rf]+\s+(?!\/tmp)/.test(command);
	const isTest = /\b(?:vitest|jest|playwright\s+test|bun\s+(?:run\s+)?test|npm\s+(?:run\s+)?test)\b/.test(command);
	const isBuildOrTypecheck = /\b(?:tsc|typecheck|vite\s+build|bun\s+run\s+build|npm\s+run\s+build)\b/.test(command);
	const isPackageInstall = /\b(?:bun\s+(?:add|install|i|remove)|npm\s+(?:i|install|ci|add)|pnpm\s+(?:add|i|install)|yarn\s+add)\b/.test(command);
	const isBrowserProbe = /\b(?:chromium|Google\s+Chrome|headless_shell|vite\s+preview|curl\s+http|--dump-dom)\b/i.test(command);
	const isSearchRead = /\b(?:grep|rg|sed\s+-n|cat|ls|find|wc|head|tail)\b/.test(command);
	const pipedCheck = (isTest || isBuildOrTypecheck) && /\|\s*(?:head|tail|grep|rg)\b/.test(command);

	const category: BashCategory = isTest
		? "test"
		: isBuildOrTypecheck
			? "build-typecheck"
			: isPackageInstall
				? "package-install"
				: isBrowserProbe
					? "browser-probe"
					: mutatesFiles
						? "file-mutation"
						: isSearchRead
							? "search-read"
							: "other";

	return { category, mutatesFiles, mutatedPaths, pipedCheck };
};

const summarizeToolCall = (name: string, args: Record<string, unknown>, cwd: string): { target: string; summary: string } => {
	if (name === "bash" && typeof args.command === "string") {
		return { target: oneLinePreview(args.command, 70), summary: `bash \`${oneLinePreview(args.command, 90)}\`` };
	}
	if (typeof args.path === "string") {
		const cleanPath = normalizeFilePath(cwd, args.path);
		if (typeof args.pattern === "string") {
			return { target: cleanPath, summary: `${name} ${JSON.stringify(args.pattern)} in ${cleanPath}` };
		}
		return { target: cleanPath, summary: `${name} ${cleanPath}` };
	}
	if (typeof args.pattern === "string") {
		return { target: args.pattern, summary: `${name} ${JSON.stringify(args.pattern)}` };
	}
	return { target: "", summary: `${name} ${oneLinePreview(JSON.stringify(args), 80)}` };
};

const parseLeadRunNote = (content: string) => {
	const headerMatch = content.match(/\[Baton\] Speculative run #(\d+) by the helper model \(([^)]+)\).*?\nIt stopped because (.*?): (\d+) turn\(s\), (\d+) tool call\(s\)\./s);
	const stopReason = headerMatch?.[3] ?? "unknown";
	const noteFiles: NoteFileStat[] = [];
	const fileRegex = /^- (created|modified|deleted) ([^\s]+) \(\+(\d+) [−-](\d+)\)$/gm;
	for (const match of content.matchAll(fileRegex)) {
		noteFiles.push({
			kind: match[1] as NoteFileStat["kind"],
			path: match[2]!,
			added: Number(match[3] ?? 0),
			removed: Number(match[4] ?? 0),
		});
	}
	const noteDiffClippedCount = (content.match(/\[diff clipped — read /g) ?? []).length;
	const noteOmittedReadsCount = (content.match(/\[omitted — read it yourself\]/g) ?? []).length;
	const noteShownReadsCount = (content.match(/→ ok \(output below\)/g) ?? []).length;
	return {
		stopReason,
		noteFiles,
		noteDiffClippedCount,
		noteOmittedReadsCount,
		noteShownReadsCount,
	};
};

const extractTextFromContent = (content: string | ContentBlock[] | undefined): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text!)
		.join("\n");
};

const extractThinkingFromContent = (content: string | ContentBlock[] | undefined): string => {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block.type === "thinking" && typeof block.thinking === "string")
		.map((block) => block.thinking!)
		.join("\n");
};

const discoverCompanionFiles = (sessionFilePath: string, cwd: string, sessionId: string): { runner?: CompanionRunnerStatus; journal?: CompanionJournalData } => {
	const sessionDir = dirname(sessionFilePath);
	const candidateRoots = [cwd, resolve(sessionDir, "../.."), resolve(sessionDir, "..")].filter(Boolean);

	let runner: CompanionRunnerStatus | undefined;
	for (const root of candidateRoots) {
		const statusPath = join(root, ".run", "status.json");
		if (existsSync(statusPath)) {
			try {
				runner = JSON.parse(readFileSync(statusPath, "utf8")) as CompanionRunnerStatus;
				break;
			} catch {
				runner = undefined;
			}
		}
	}

	let journal: CompanionJournalData | undefined;
	const safeSessionId = sessionId.replace(/[^\w.-]/g, "_");
	for (const root of candidateRoots) {
		const eventsPath = join(root, ".pi", "baton", "sessions", safeSessionId, "events.jsonl");
		if (existsSync(eventsPath)) {
			try {
				const rawLines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
				const keepalives: CompanionJournalData["keepalives"] = [];
				const undos: CompanionJournalData["undos"] = [];
				let config: Record<string, unknown> | undefined;
				for (const line of rawLines) {
					const parsed = JSON.parse(line) as Record<string, unknown>;
					if (parsed.kind === "session" && typeof parsed.config === "object" && parsed.config !== null) {
						config = parsed.config as Record<string, unknown>;
					} else if (parsed.kind === "cache_keepalive") {
						keepalives.push({
							ts: String(parsed.ts ?? ""),
							run: typeof parsed.run === "number" ? parsed.run : undefined,
							model: typeof parsed.model === "string" ? parsed.model : undefined,
							sincePreviousMs: typeof parsed.sincePreviousMs === "number" ? parsed.sincePreviousMs : undefined,
							error: typeof parsed.error === "string" ? parsed.error : undefined,
							cost: typeof parsed.cost === "number" ? parsed.cost : undefined,
							cacheRead: typeof parsed.cacheRead === "number" ? parsed.cacheRead : undefined,
							cacheWrite: typeof parsed.cacheWrite === "number" ? parsed.cacheWrite : undefined,
						});
					} else if (parsed.kind === "undo") {
						undos.push({
							ts: String(parsed.ts ?? ""),
							run: Number(parsed.run ?? 0),
							restored: Array.isArray(parsed.restored) ? (parsed.restored as string[]) : undefined,
							deleted: Array.isArray(parsed.deleted) ? (parsed.deleted as string[]) : undefined,
							changedLater: Array.isArray(parsed.changedLater) ? (parsed.changedLater as string[]) : undefined,
						});
					}
				}
				journal = { config, keepalives, undos };
				break;
			} catch {
				journal = undefined;
			}
		}
	}

	return { runner, journal };
};

export function resolveSessionFiles(inputs: string[]): string[] {
	const resolvedFiles: string[] = [];
	for (const input of inputs) {
		const fullPath = resolve(input);
		if (!existsSync(fullPath)) {
			throw new Error(`Path does not exist: ${input}`);
		}
		const stats = statSync(fullPath);
		if (stats.isFile()) {
			resolvedFiles.push(fullPath);
			continue;
		}
		if (stats.isDirectory()) {
			const directSessionsDir = join(fullPath, ".pi", "sessions");
			const searchDir = existsSync(directSessionsDir) ? directSessionsDir : fullPath;
			const entries = readdirSync(searchDir)
				.filter((name) => name.endsWith(".jsonl") && !name.includes("events.jsonl"))
				.sort()
				.map((name) => join(searchDir, name));
			if (entries.length === 0) {
				throw new Error(`No session .jsonl files found in directory: ${input}`);
			}
			resolvedFiles.push(...entries);
		}
	}
	return resolvedFiles;
}

export function analyzeSessionFile(sessionFilePath: string): SessionAnalysis {
	const absolutePath = resolve(sessionFilePath);
	const rawText = readFileSync(absolutePath, "utf8");
	const sessionFileBytes = Buffer.byteLength(rawText, "utf8");
	const lines = rawText
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as RawSessionEntry);

	const sessionEntry = lines.find((entry) => entry.type === "session");
	const sessionInfoEntry = lines.find((entry) => entry.type === "session_info");
	const sessionId = sessionEntry?.id ?? basename(absolutePath, ".jsonl");
	const sessionName = sessionInfoEntry?.name ?? basename(absolutePath, ".jsonl");
	const cwd = sessionEntry?.cwd ?? "";

	const { runner: companionRunner, journal: companionJournal } = discoverCompanionFiles(absolutePath, cwd, sessionId);

	const systemMessageEntry = lines.find((entry) => entry.type === "message" && entry.message?.role === "system");
	const systemSectionsText = Object.values(systemMessageEntry?.message?.sections ?? {}).join("\n");
	const systemPromptText = extractTextFromContent(systemMessageEntry?.message?.content) || systemSectionsText;
	const systemPromptChars = systemPromptText.length;

	const userMessageEntry = lines.find((entry) => entry.type === "message" && entry.message?.role === "user");
	const userPromptText = extractTextFromContent(userMessageEntry?.message?.content);
	const userPromptPreview = oneLinePreview(userPromptText, 140);

	const hasBatonMessages = lines.some((entry) => entry.type === "custom_message" && (entry.customType === "baton-helper" || entry.customType === "baton-lead"));
	const hasBatonSystemPrompt = systemPromptText.includes("# Baton: speculative runs");
	const withBaton = Boolean(hasBatonMessages || hasBatonSystemPrompt || companionRunner?.withBaton || companionJournal);

	const toolResultsByCallId = new Map<string, RawSessionEntry>();
	for (const entry of lines) {
		if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId) {
			toolResultsByCallId.set(entry.message.toolCallId, entry);
		}
	}

	const firstAssistantModel = lines.find((entry) => entry.type === "message" && entry.message?.role === "assistant")?.message?.model;
	const configuredLead = typeof companionJournal?.config?.lead === "string" ? companionJournal.config.lead : undefined;
	const configuredHelper = typeof companionJournal?.config?.helper === "string" ? companionJournal.config.helper : undefined;
	const leadModel = stripRouterPrefix(configuredLead ?? firstAssistantModel ?? "anthropic/claude-opus-5.5");

	let helperModel: string | undefined = configuredHelper ? stripRouterPrefix(configuredHelper) : undefined;
	for (const entry of lines) {
		if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.model) {
			const normalized = stripRouterPrefix(entry.message.model);
			if (!isSameNormalizedModel(normalized, leadModel)) {
				helperModel = normalized;
				break;
			}
		}
	}

	const turns: AssistantTurnRecord[] = [];
	const allToolCalls: ToolCallRecord[] = [];
	const runsByNumber = new Map<number, SpeculativeRunRecord>();
	let activeRunNumber: number | undefined;
	let currentThinkingLevel = "default";
	let turnCounter = 0;

	for (const [entryIndex, entry] of lines.entries()) {
		if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
			currentThinkingLevel = entry.thinkingLevel;
			continue;
		}

		if (entry.type === "custom_message" && entry.customType === "baton-helper") {
			const match = entry.content?.match(/\[Baton\] Speculative run #(\d+)/);
			const runNumber = match ? Number(match[1]) : runsByNumber.size + 1;
			activeRunNumber = runNumber;
			const previousLeadTurn = [...turns].reverse().find((turn) => turn.role === "lead");
			runsByNumber.set(runNumber, {
				runNumber,
				helperModel: helperModel ?? "helper",
				startedAtIso: entry.timestamp ?? "",
				wallDurationMs: 0,
				finished: false,
				stopReason: "in progress (session ended before run finished)",
				triggerLeadTurnIndex: previousLeadTurn?.turnIndex,
				triggerLeadCalls: previousLeadTurn?.toolCalls.map((call) => call.summary) ?? [],
				turns: 0,
				toolCalls: 0,
				toolErrors: 0,
				callsPerTurn: 0,
				costUsd: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				contextStartTokens: 0,
				contextEndTokens: 0,
				thinkingChars: 0,
				textChars: 0,
				turnLatencyMs: computeDistribution([]),
				outputTokensPerSec: computeDistribution([]),
				noteFiles: [],
				noteDiffClippedCount: 0,
				noteOmittedReadsCount: 0,
				noteShownReadsCount: 0,
				editedFiles: [],
				bashMutatedFiles: [],
				leadReaction: "unfinished",
			});
			continue;
		}

		if (entry.type === "custom_message" && entry.customType === "baton-lead") {
			const match = entry.content?.match(/\[Baton\] Speculative run #(\d+)/);
			const runNumber = match ? Number(match[1]) : activeRunNumber;
			if (runNumber !== undefined && runsByNumber.has(runNumber)) {
				const runRecord = runsByNumber.get(runNumber)!;
				const parsedNote = parseLeadRunNote(entry.content ?? "");
				runRecord.finished = true;
				runRecord.endedAtIso = entry.timestamp ?? "";
				runRecord.wallDurationMs = Math.max(0, Date.parse(runRecord.endedAtIso) - Date.parse(runRecord.startedAtIso));
				runRecord.stopReason = parsedNote.stopReason;
				runRecord.noteChars = (entry.content ?? "").length;
				runRecord.noteFiles = parsedNote.noteFiles;
				runRecord.noteDiffClippedCount = parsedNote.noteDiffClippedCount;
				runRecord.noteOmittedReadsCount = parsedNote.noteOmittedReadsCount;
				runRecord.noteShownReadsCount = parsedNote.noteShownReadsCount;
				runRecord.leadReaction = "none";
			}
			activeRunNumber = undefined;
			continue;
		}

		if (entry.type === "message" && entry.message?.role === "assistant") {
			turnCounter++;
			const msg = entry.message;
			const model = stripRouterPrefix(msg.model);
			const role: "lead" | "helper" = activeRunNumber !== undefined || (helperModel && isSameNormalizedModel(model, helperModel)) ? "helper" : "lead";
			const usage = msg.usage ?? {};
			const cost = usage.cost ?? {};
			const inputTokens = usage.input ?? 0;
			const outputTokens = usage.output ?? 0;
			const cacheReadTokens = usage.cacheRead ?? 0;
			const cacheWriteTokens = usage.cacheWrite ?? 0;
			const reasoningTokens = usage.reasoning ?? 0;
			const contextTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
			const totalTokens = usage.totalTokens ?? contextTokens + outputTokens;
			const durationMs = msg.durationMs ?? 0;
			const endedAtMs = entry.timestamp ? Date.parse(entry.timestamp) : (msg.timestamp ?? 0) + durationMs;
			const startedAtMs = msg.timestamp ?? endedAtMs - durationMs;
			const outputTokensPerSec = durationMs > 0 ? outputTokens / (durationMs / 1000) : 0;

			const textContent = extractTextFromContent(msg.content);
			const thinkingContent = extractThinkingFromContent(msg.content);
			const blocks = Array.isArray(msg.content) ? msg.content : [];
			const turnToolCalls: ToolCallRecord[] = [];

			for (const block of blocks) {
				if (block.type !== "toolCall" || !block.id) continue;
				const callName = block.name ?? "unknown";
				const callArgs = block.arguments ?? {};
				const resultEntry = toolResultsByCallId.get(block.id);
				const resultMsg = resultEntry?.message;
				const outputText = extractTextFromContent(resultMsg?.content);
				const { target, summary } = summarizeToolCall(callName, callArgs, cwd);
				const bashInfo = callName === "bash" && typeof callArgs.command === "string" ? classifyBashCommand(callArgs.command, cwd) : undefined;

				const toolRecord: ToolCallRecord = {
					id: block.id,
					name: callName,
					args: callArgs,
					target,
					summary,
					turnIndex: turnCounter,
					model,
					role,
					runNumber: activeRunNumber,
					timestampIso: resultEntry?.timestamp ?? entry.timestamp ?? "",
					durationMs: resultMsg?.durationMs ?? 0,
					isError: Boolean(resultMsg?.isError),
					outputChars: outputText.length,
					outputPreview: oneLinePreview(outputText, 120),
					bashCategory: bashInfo?.category,
					bashMutatesFiles: bashInfo?.mutatesFiles,
					bashPipedCheck: bashInfo?.pipedCheck,
				};
				turnToolCalls.push(toolRecord);
				allToolCalls.push(toolRecord);

				if (activeRunNumber !== undefined && runsByNumber.has(activeRunNumber)) {
					const runRecord = runsByNumber.get(activeRunNumber)!;
					if ((callName === "edit" || callName === "write") && typeof callArgs.path === "string" && !toolRecord.isError) {
						const normPath = normalizeFilePath(cwd, callArgs.path);
						if (!runRecord.editedFiles.includes(normPath)) runRecord.editedFiles.push(normPath);
					}
					if (bashInfo?.mutatesFiles) {
						for (const mutatedPath of bashInfo.mutatedPaths) {
							if (!runRecord.bashMutatedFiles.includes(mutatedPath)) runRecord.bashMutatedFiles.push(mutatedPath);
						}
					}
				}
			}

			const toolExecutionMs = turnToolCalls.reduce((acc, call) => acc + call.durationMs, 0);

			const turnRecord: AssistantTurnRecord = {
				turnIndex: turnCounter,
				entryIndex,
				model,
				provider: msg.provider ?? "openrouter",
				role,
				runNumber: activeRunNumber,
				thinkingLevel: msg.thinkingLevel ?? msg.providerThinkingLevel ?? currentThinkingLevel,
				stopReason: msg.stopReason ?? "unknown",
				errorMessage: msg.errorMessage,
				startedAtMs,
				endedAtMs,
				timestampIso: entry.timestamp ?? new Date(endedAtMs).toISOString(),
				durationMs,
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheWriteTokens,
				reasoningTokens,
				contextTokens,
				totalTokens,
				outputTokensPerSec,
				costInputUsd: cost.input ?? 0,
				costOutputUsd: cost.output ?? 0,
				costCacheReadUsd: cost.cacheRead ?? 0,
				costCacheWriteUsd: cost.cacheWrite ?? 0,
				costTotalUsd: cost.total ?? 0,
				thinkingChars: thinkingContent.length,
				textChars: textContent.length,
				textContent,
				toolCalls: turnToolCalls,
				toolExecutionMs,
			};
			turns.push(turnRecord);
		}
	}

	const timestampsMs = lines
		.map((entry) => (entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN))
		.filter((value) => Number.isFinite(value));
	const startMs = timestampsMs.length ? Math.min(...timestampsMs) : 0;
	const endMs = timestampsMs.length ? Math.max(...timestampsMs) : 0;
	const startedAtIso = startMs ? new Date(startMs).toISOString() : "";
	const endedAtIso = endMs ? new Date(endMs).toISOString() : "";
	const transcriptWallMs = Math.max(0, endMs - startMs);
	const runnerWallMs = companionRunner?.elapsedSec ? companionRunner.elapsedSec * 1000 : undefined;

	const runs: SpeculativeRunRecord[] = [...runsByNumber.values()].sort((a, b) => a.runNumber - b.runNumber);
	for (const runRecord of runs) {
		const runTurns = turns.filter((turn) => turn.runNumber === runRecord.runNumber);
		runRecord.turns = runTurns.length;
		runRecord.toolCalls = runTurns.reduce((sum, turn) => sum + turn.toolCalls.length, 0);
		runRecord.toolErrors = runTurns.reduce((sum, turn) => sum + turn.toolCalls.filter((call) => call.isError).length, 0);
		runRecord.callsPerTurn = runRecord.turns > 0 ? runRecord.toolCalls / runRecord.turns : 0;
		runRecord.costUsd = runTurns.reduce((sum, turn) => sum + turn.costTotalUsd, 0);
		runRecord.inputTokens = runTurns.reduce((sum, turn) => sum + turn.inputTokens, 0);
		runRecord.outputTokens = runTurns.reduce((sum, turn) => sum + turn.outputTokens, 0);
		runRecord.cacheReadTokens = runTurns.reduce((sum, turn) => sum + turn.cacheReadTokens, 0);
		runRecord.contextStartTokens = runTurns[0]?.contextTokens ?? 0;
		runRecord.contextEndTokens = runTurns[runTurns.length - 1]?.contextTokens ?? 0;
		runRecord.thinkingChars = runTurns.reduce((sum, turn) => sum + turn.thinkingChars, 0);
		runRecord.textChars = runTurns.reduce((sum, turn) => sum + turn.textChars, 0);
		runRecord.turnLatencyMs = computeDistribution(runTurns.map((turn) => turn.durationMs));
		runRecord.outputTokensPerSec = computeDistribution(runTurns.filter((turn) => turn.durationMs > 0).map((turn) => turn.outputTokensPerSec));

		if (!runRecord.finished) {
			const lastEntryMs = endMs || Date.parse(runRecord.startedAtIso);
			runRecord.wallDurationMs = Math.max(0, lastEntryMs - Date.parse(runRecord.startedAtIso));
			if (companionRunner?.stopReason) {
				runRecord.stopReason = `interrupted by runner (${companionRunner.stopReason})`;
			}
		} else {
			const followupLeadTurn = turns.find((turn) => turn.role === "lead" && Date.parse(turn.timestampIso) >= Date.parse(runRecord.endedAtIso!));
			if (followupLeadTurn) {
				runRecord.leadFollowupTurnIndex = followupLeadTurn.turnIndex;
				runRecord.leadFollowupCacheReadTokens = followupLeadTurn.cacheReadTokens;
				runRecord.leadFollowupCacheWriteTokens = followupLeadTurn.cacheWriteTokens;
				runRecord.leadFollowupCostUsd = followupLeadTurn.costTotalUsd;

				const prevLeadTurn = [...turns]
					.filter((turn) => turn.role === "lead" && turn.turnIndex < followupLeadTurn.turnIndex)
					.pop();
				if (prevLeadTurn) {
					runRecord.leadGapSincePrevLeadMs = Math.max(0, followupLeadTurn.startedAtMs - prevLeadTurn.startedAtMs);
				}

				const calledUndo = followupLeadTurn.toolCalls.some((call) => call.name === "baton_undo");
				const touchedSameFiles = followupLeadTurn.toolCalls.some(
					(call) => (call.name === "edit" || call.name === "write") && runRecord.editedFiles.includes(call.target),
				);
				runRecord.leadReaction = calledUndo ? "undone" : touchedSameFiles ? "fixed" : "kept";

				const steeringMatch = followupLeadTurn.textContent.match(/Helper:\s*([^\n]+)/i);
				if (steeringMatch?.[1]) {
					runRecord.leadSteeringNote = steeringMatch[1].trim();
				}
			}
		}
	}

	const keepaliveByModel = new Map<string, { pings: number; costUsd: number }>();
	for (const ping of companionJournal?.keepalives ?? []) {
		const pingModel = stripRouterPrefix(ping.model ?? leadModel);
		const current = keepaliveByModel.get(pingModel) ?? { pings: 0, costUsd: 0 };
		current.pings += 1;
		current.costUsd += ping.cost ?? 0;
		keepaliveByModel.set(pingModel, current);
	}

	const keepaliveCostUsd = [...keepaliveByModel.values()].reduce((sum, item) => sum + item.costUsd, 0);
	const transcriptCostUsd = turns.reduce((sum, turn) => sum + turn.costTotalUsd, 0);
	const totalCostUsd = transcriptCostUsd + keepaliveCostUsd;

	const distinctModels = [...new Set(turns.map((turn) => turn.model))];
	const models: ModelAggregate[] = distinctModels.map((modelName) => {
		const modelTurns = turns.filter((turn) => turn.model === modelName);
		const role = modelTurns[0]?.role ?? "lead";
		const inputTokens = modelTurns.reduce((sum, turn) => sum + turn.inputTokens, 0);
		const outputTokens = modelTurns.reduce((sum, turn) => sum + turn.outputTokens, 0);
		const cacheReadTokens = modelTurns.reduce((sum, turn) => sum + turn.cacheReadTokens, 0);
		const cacheWriteTokens = modelTurns.reduce((sum, turn) => sum + turn.cacheWriteTokens, 0);
		const reasoningTokens = modelTurns.reduce((sum, turn) => sum + turn.reasoningTokens, 0);
		const totalPromptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
		const totalTokens = modelTurns.reduce((sum, turn) => sum + turn.totalTokens, 0);
		const costInputUsd = modelTurns.reduce((sum, turn) => sum + turn.costInputUsd, 0);
		const costOutputUsd = modelTurns.reduce((sum, turn) => sum + turn.costOutputUsd, 0);
		const costCacheReadUsd = modelTurns.reduce((sum, turn) => sum + turn.costCacheReadUsd, 0);
		const costCacheWriteUsd = modelTurns.reduce((sum, turn) => sum + turn.costCacheWriteUsd, 0);
		const keepaliveInfo = keepaliveByModel.get(modelName) ?? { pings: 0, costUsd: 0 };
		const costTotalUsd = modelTurns.reduce((sum, turn) => sum + turn.costTotalUsd, 0) + keepaliveInfo.costUsd;
		const toolCallsCount = modelTurns.reduce((sum, turn) => sum + turn.toolCalls.length, 0);
		const toolErrorsCount = modelTurns.reduce((sum, turn) => sum + turn.toolCalls.filter((call) => call.isError).length, 0);

		const allInputSideCost = costInputUsd + costCacheReadUsd + costCacheWriteUsd;
		const effectiveInputUsdPerM = totalPromptTokens > 0 ? (allInputSideCost / totalPromptTokens) * 1_000_000 : 0;
		const effectiveOutputUsdPerM = outputTokens > 0 ? (costOutputUsd / outputTokens) * 1_000_000 : 0;

		return {
			model: modelName,
			role,
			turns: modelTurns.length,
			turnsWithTools: modelTurns.filter((turn) => turn.toolCalls.length > 0).length,
			turnsStopped: modelTurns.filter((turn) => turn.stopReason === "stop").length,
			turnsErrored: modelTurns.filter((turn) => turn.stopReason === "error" || turn.stopReason === "aborted").length,
			toolCalls: toolCallsCount,
			toolErrors: toolErrorsCount,
			callsPerTurn: modelTurns.length > 0 ? toolCallsCount / modelTurns.length : 0,
			batchedTurns: modelTurns.filter((turn) => turn.toolCalls.length > 1).length,
			maxCallsInTurn: modelTurns.reduce((max, turn) => Math.max(max, turn.toolCalls.length), 0),
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			reasoningTokens,
			totalTokens,
			cacheHitRate: totalPromptTokens > 0 ? cacheReadTokens / totalPromptTokens : 0,
			peakContextTokens: modelTurns.reduce((max, turn) => Math.max(max, turn.contextTokens), 0),
			avgContextTokens: modelTurns.length > 0 ? totalPromptTokens / modelTurns.length : 0,
			costInputUsd,
			costOutputUsd,
			costCacheReadUsd,
			costCacheWriteUsd,
			costTotalUsd,
			costShare: totalCostUsd > 0 ? costTotalUsd / totalCostUsd : 0,
			effectiveInputUsdPerM,
			effectiveOutputUsdPerM,
			thinkingChars: modelTurns.reduce((sum, turn) => sum + turn.thinkingChars, 0),
			textChars: modelTurns.reduce((sum, turn) => sum + turn.textChars, 0),
			latencyMs: computeDistribution(modelTurns.map((turn) => turn.durationMs)),
			costPerTurnUsd: computeDistribution(modelTurns.map((turn) => turn.costTotalUsd)),
			outputTokensPerSec: computeDistribution(modelTurns.filter((turn) => turn.durationMs > 0).map((turn) => turn.outputTokensPerSec)),
			keepalivePings: keepaliveInfo.pings,
			keepaliveCostUsd: keepaliveInfo.costUsd,
		};
	});

	const leadAggregate = models.find((m) => m.role === "lead");
	const helperAggregate = models.find((m) => m.role === "helper");
	const leadCostUsd = leadAggregate?.costTotalUsd ?? 0;
	const helperCostUsd = helperAggregate?.costTotalUsd ?? 0;

	const leadOutputRatePerToken =
		leadAggregate && leadAggregate.outputTokens > 0 ? leadAggregate.costOutputUsd / leadAggregate.outputTokens : 0.000025;
	const leadCacheReadRatePerToken =
		leadAggregate && leadAggregate.cacheReadTokens > 0 ? leadAggregate.costCacheReadUsd / leadAggregate.cacheReadTokens : 0.0000005;
	const leadCacheWriteRatePerToken =
		leadAggregate && leadAggregate.cacheWriteTokens > 0 ? leadAggregate.costCacheWriteUsd / leadAggregate.cacheWriteTokens : 0.00000625;

	const helperTotalPromptTokens = (helperAggregate?.inputTokens ?? 0) + (helperAggregate?.cacheReadTokens ?? 0);
	const helperOutputTokens = helperAggregate?.outputTokens ?? 0;
	const counterfactualHelperAsLeadUsd =
		helperTotalPromptTokens * leadCacheReadRatePerToken +
		helperOutputTokens * (leadOutputRatePerToken + leadCacheWriteRatePerToken * 0.5);
	const estimatedSingleModelLeadCostUsd = helperAggregate ? leadCostUsd + counterfactualHelperAsLeadUsd : totalCostUsd;
	const estimatedSavingsUsd = Math.max(0, estimatedSingleModelLeadCostUsd - totalCostUsd);
	const estimatedSavingsRatio = estimatedSingleModelLeadCostUsd > 0 ? estimatedSavingsUsd / estimatedSingleModelLeadCostUsd : 0;

	const distinctToolNames = [...new Set(allToolCalls.map((call) => call.name))];
	const tools: ToolAggregate[] = distinctToolNames
		.map((toolName) => {
			const matching = allToolCalls.filter((call) => call.name === toolName);
			const errors = matching.filter((call) => call.isError).length;
			const totalOutputChars = matching.reduce((sum, call) => sum + call.outputChars, 0);
			return {
				name: toolName,
				totalCalls: matching.length,
				leadCalls: matching.filter((call) => call.role === "lead").length,
				helperCalls: matching.filter((call) => call.role === "helper").length,
				errors,
				errorRate: matching.length > 0 ? errors / matching.length : 0,
				durationMs: computeDistribution(matching.map((call) => call.durationMs)),
				totalOutputChars,
				avgOutputChars: matching.length > 0 ? totalOutputChars / matching.length : 0,
			};
		})
		.sort((a, b) => b.totalCalls - a.totalCalls);

	const bashBreakdown: Record<BashCategory, { calls: number; errors: number; pipedChecks: number }> = {
		test: { calls: 0, errors: 0, pipedChecks: 0 },
		"build-typecheck": { calls: 0, errors: 0, pipedChecks: 0 },
		"package-install": { calls: 0, errors: 0, pipedChecks: 0 },
		"browser-probe": { calls: 0, errors: 0, pipedChecks: 0 },
		"file-mutation": { calls: 0, errors: 0, pipedChecks: 0 },
		"search-read": { calls: 0, errors: 0, pipedChecks: 0 },
		other: { calls: 0, errors: 0, pipedChecks: 0 },
	};
	for (const call of allToolCalls) {
		if (call.name !== "bash" || !call.bashCategory) continue;
		const bucket = bashBreakdown[call.bashCategory];
		bucket.calls += 1;
		if (call.isError) bucket.errors += 1;
		if (call.bashPipedCheck) bucket.pipedChecks += 1;
	}

	const hotspotMap = new Map<string, FileHotspot>();
	const ensureHotspot = (filePath: string): FileHotspot => {
		const existing = hotspotMap.get(filePath);
		if (existing) return existing;
		const created: FileHotspot = {
			path: filePath,
			reads: 0,
			writes: 0,
			edits: 0,
			editErrors: 0,
			bashMutations: 0,
			leadTouches: 0,
			helperTouches: 0,
			addedLines: 0,
			removedLines: 0,
		};
		hotspotMap.set(filePath, created);
		return created;
	};

	for (const call of allToolCalls) {
		if ((call.name === "read" || call.name === "write" || call.name === "edit") && typeof call.args.path === "string") {
			const filePath = normalizeFilePath(cwd, call.args.path);
			const spot = ensureHotspot(filePath);
			if (call.name === "read") spot.reads += 1;
			if (call.name === "write") spot.writes += 1;
			if (call.name === "edit") {
				spot.edits += 1;
				if (call.isError) spot.editErrors += 1;
			}
			if (call.role === "lead") spot.leadTouches += 1;
			else spot.helperTouches += 1;
		}
		if (call.name === "bash" && typeof call.args.command === "string") {
			const bashInfo = classifyBashCommand(call.args.command, cwd);
			for (const mutatedPath of bashInfo.mutatedPaths) {
				const spot = ensureHotspot(mutatedPath);
				spot.bashMutations += 1;
				if (call.role === "lead") spot.leadTouches += 1;
				else spot.helperTouches += 1;
			}
		}
	}

	for (const runRecord of runs) {
		for (const fileStat of runRecord.noteFiles) {
			const spot = ensureHotspot(fileStat.path);
			spot.addedLines += fileStat.added;
			spot.removedLines += fileStat.removed;
		}
	}

	const fileHotspots = [...hotspotMap.values()].sort(
		(a, b) => b.reads + b.writes + b.edits + b.bashMutations - (a.reads + a.writes + a.edits + a.bashMutations),
	);

	const timeline: TimelineSegment[] = [];
	const emittedRuns = new Set<number>();
	for (const turn of turns) {
		if (turn.role === "lead") {
			timeline.push({
				kind: "lead-turn",
				label: `Lead Turn #${turn.turnIndex} (${turn.model})`,
				startedAtIso: turn.timestampIso,
				durationMs: turn.durationMs + turn.toolExecutionMs,
				turns: 1,
				toolCalls: turn.toolCalls.length,
				toolErrors: turn.toolCalls.filter((call) => call.isError).length,
				costUsd: turn.costTotalUsd,
				contextTokens: turn.contextTokens,
				summary:
					turn.toolCalls.length > 0
						? turn.toolCalls.map((call) => call.summary).join("; ")
						: `Final answer (${turn.textChars} chars)`,
			});
		} else if (turn.runNumber !== undefined && !emittedRuns.has(turn.runNumber)) {
			emittedRuns.add(turn.runNumber);
			const runRecord = runsByNumber.get(turn.runNumber);
			if (runRecord) {
				timeline.push({
					kind: "helper-run",
					label: `Speculative Run #${runRecord.runNumber} (${runRecord.helperModel})`,
					startedAtIso: runRecord.startedAtIso,
					durationMs: runRecord.wallDurationMs,
					turns: runRecord.turns,
					toolCalls: runRecord.toolCalls,
					toolErrors: runRecord.toolErrors,
					costUsd: runRecord.costUsd,
					contextTokens: runRecord.contextEndTokens,
					summary: `${runRecord.stopReason} | files: ${runRecord.editedFiles.join(", ") || "none"}`,
				});
			}
		}
	}

	const leadInferenceMs = turns.filter((turn) => turn.role === "lead").reduce((sum, turn) => sum + turn.durationMs, 0);
	const helperInferenceMs = turns.filter((turn) => turn.role === "helper").reduce((sum, turn) => sum + turn.durationMs, 0);
	const toolExecutionMs = allToolCalls.reduce((sum, call) => sum + call.durationMs, 0);
	const effectiveWallMs = runnerWallMs ?? transcriptWallMs;
	const unaccountedWallMs = Math.max(0, effectiveWallMs - (leadInferenceMs + helperInferenceMs + toolExecutionMs));

	const lastTurn = turns[turns.length - 1];
	const hasUnfinishedRun = runs.some((run) => !run.finished);
	const completedCleanly = Boolean(
		!hasUnfinishedRun &&
			lastTurn &&
			lastTurn.role === "lead" &&
			lastTurn.stopReason === "stop" &&
			(companionRunner?.settled ?? true),
	);

	const terminationSummary = companionRunner?.stopReason
		? `${companionRunner.stopReason}${companionRunner.exitCode ? ` (exit ${companionRunner.exitCode})` : ""}`
		: hasUnfinishedRun
			? "interrupted during active helper speculative run"
			: lastTurn
				? `last turn (${lastTurn.model}) ended with ${lastTurn.stopReason}`
				: "empty session";

	const diagnostics: DiagnosticFinding[] = [];

	if (hasUnfinishedRun) {
		const unfinished = runs.find((run) => !run.finished)!;
		diagnostics.push({
			severity: "critical",
			category: "unfinished-run",
			message: `Run #${unfinished.runNumber} never completed (${unfinished.turns} turns, ${(unfinished.wallDurationMs / 1000).toFixed(1)}s, $${unfinished.costUsd.toFixed(4)}): ${unfinished.stopReason}.`,
		});
	}

	if (runs.length >= 2) {
		const firstRunAvgMs = runs[0]!.turnLatencyMs.avg;
		for (const runRecord of runs.slice(1)) {
			if (firstRunAvgMs > 0 && runRecord.turnLatencyMs.avg >= firstRunAvgMs * 3 && runRecord.turnLatencyMs.avg >= 10_000) {
				const ratio = (runRecord.turnLatencyMs.avg / firstRunAvgMs).toFixed(1);
				diagnostics.push({
					severity: "warning",
					category: "latency-degradation",
					message: `Run #${runRecord.runNumber} helper turn latency averaged ${(runRecord.turnLatencyMs.avg / 1000).toFixed(1)}s (${ratio}x slower than Run #1's ${(firstRunAvgMs / 1000).toFixed(1)}s; max ${(runRecord.turnLatencyMs.max / 1000).toFixed(1)}s, avg ${runRecord.outputTokensPerSec.avg.toFixed(1)} out tok/s).`,
				});
			}
		}
	}

	for (const runRecord of runs) {
		if (runRecord.bashMutatedFiles.length > 0) {
			diagnostics.push({
				severity: "warning",
				category: "bash-file-mutation",
				message: `Run #${runRecord.runNumber} modified files via bash (${runRecord.bashMutatedFiles.join(", ")}), which bypasses baton_undo and the run note diff.`,
			});
		}
		if (runRecord.noteOmittedReadsCount > 0 || runRecord.noteDiffClippedCount > 0) {
			diagnostics.push({
				severity: "info",
				category: "note-cap-pressure",
				message: `Run #${runRecord.runNumber} note (${runRecord.noteChars?.toLocaleString()} chars) omitted ${runRecord.noteOmittedReadsCount} read output(s) and clipped ${runRecord.noteDiffClippedCount} diff(s).`,
			});
		}
		if (runRecord.stopReason.includes("safety cap")) {
			diagnostics.push({
				severity: "warning",
				category: "turn-cap-reached",
				message: `Run #${runRecord.runNumber} hit the ${runRecord.turns}-turn safety cap before stopping naturally.`,
			});
		}
	}

	const totalPipedChecks = Object.values(bashBreakdown).reduce((sum, item) => sum + item.pipedChecks, 0);
	if (withBaton && totalPipedChecks > 0) {
		diagnostics.push({
			severity: "info",
			category: "piped-checks",
			message: `${totalPipedChecks} test/build bash call(s) piped output through head/tail/grep despite Baton already showing the 2,000-char tail.`,
		});
	}

	for (const spot of fileHotspots) {
		if (spot.reads >= 3) {
			diagnostics.push({
				severity: "info",
				category: "repeated-reads",
				message: `File ${spot.path} was read ${spot.reads} times (${spot.helperTouches} helper, ${spot.leadTouches} lead touches).`,
			});
		}
	}

	for (const turn of turns) {
		if (turn.role === "lead" && turn.cacheWriteTokens > 20_000) {
			diagnostics.push({
				severity: "info",
				category: "lead-cache-write",
				message: `Lead turn #${turn.turnIndex} wrote ${turn.cacheWriteTokens.toLocaleString()} tokens to cache ($${turn.costCacheWriteUsd.toFixed(4)} of $${turn.costTotalUsd.toFixed(4)} turn cost).`,
			});
		}
	}

	const slowestTurns = [...turns].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
	const slowestToolCalls = [...allToolCalls].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);

	return {
		sessionFilePath: absolutePath,
		sessionFileBytes,
		totalJsonlEntries: lines.length,
		sessionId,
		sessionName,
		cwd,
		startedAtIso,
		endedAtIso,
		transcriptWallMs,
		runnerWallMs,
		leadInferenceMs,
		helperInferenceMs,
		toolExecutionMs,
		unaccountedWallMs,
		withBaton,
		leadModel,
		helperModel,
		completedCleanly,
		terminationSummary,
		userPromptPreview,
		systemPromptChars,
		totalTurns: turns.length,
		leadTurns: turns.filter((turn) => turn.role === "lead").length,
		helperTurns: turns.filter((turn) => turn.role === "helper").length,
		totalToolCalls: allToolCalls.length,
		totalToolErrors: allToolCalls.filter((call) => call.isError).length,
		totalCostUsd,
		leadCostUsd,
		helperCostUsd,
		keepaliveCostUsd,
		estimatedSingleModelLeadCostUsd,
		estimatedSavingsUsd,
		estimatedSavingsRatio,
		models,
		runs,
		tools,
		bashBreakdown,
		fileHotspots,
		timeline,
		slowestTurns,
		slowestToolCalls,
		diagnostics,
		companionRunner,
		companionJournal,
		turns,
	};
}

const formatDuration = (ms: number): string => {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const totalSec = ms / 1000;
	if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec - minutes * 60;
	return `${minutes}m ${seconds.toFixed(1)}s (${totalSec.toFixed(1)}s)`;
};

const formatUsd = (usd: number): string => `$${usd.toFixed(4)}`;

const formatPct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

const formatInt = (num: number): string => Math.round(num).toLocaleString("en-US");

const padRight = (text: string, width: number): string => (text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length));

const padLeft = (text: string, width: number): string => (text.length >= width ? text.slice(0, width) : " ".repeat(width - text.length) + text);

const renderTable = (headers: string[], rows: string[][], rightAlignCols: Set<number> = new Set()): string => {
	const widths = headers.map((header, colIndex) =>
		Math.max(header.length, ...rows.map((row) => (row[colIndex] ?? "").length)),
	);
	const formatRow = (row: string[]) =>
		row
			.map((cell, colIndex) => (rightAlignCols.has(colIndex) ? padLeft(cell, widths[colIndex]!) : padRight(cell, widths[colIndex]!)))
			.join("  ");
	const divider = widths.map((w) => "─".repeat(w)).join("──");
	return [formatRow(headers), divider, ...rows.map(formatRow)].join("\n");
};

export function renderHumanReport(analysis: SessionAnalysis, options: { showTurns?: boolean; showCalls?: boolean } = {}): string {
	const sections: string[] = [];
	const effectiveWallMs = analysis.runnerWallMs ?? analysis.transcriptWallMs;

	sections.push(
		[
			`══════════════════════════════════════════════════════════════════════════════`,
			` SESSION ANALYSIS: ${analysis.sessionName} (${analysis.sessionId})`,
			`══════════════════════════════════════════════════════════════════════════════`,
			`File:          ${analysis.sessionFilePath} (${(analysis.sessionFileBytes / 1024).toFixed(1)} KB, ${analysis.totalJsonlEntries} JSONL entries)`,
			`Working Dir:   ${analysis.cwd || "(unknown)"}`,
			`Mode:          ${analysis.withBaton ? `Baton Speculative (Lead: ${analysis.leadModel}, Helper: ${analysis.helperModel ?? "none"})` : `Single-Model (${analysis.leadModel})`}`,
			`Status:        ${analysis.completedCleanly ? "COMPLETED CLEANLY" : "INCOMPLETE / INTERRUPTED"} — ${analysis.terminationSummary}`,
			`Time Window:   ${analysis.startedAtIso} → ${analysis.endedAtIso}`,
			`Wall Duration: ${formatDuration(effectiveWallMs)}${analysis.runnerWallMs ? ` (transcript span: ${formatDuration(analysis.transcriptWallMs)})` : ""}`,
			`Time Split:    Lead Inference: ${formatDuration(analysis.leadInferenceMs)} (${formatPct(effectiveWallMs > 0 ? analysis.leadInferenceMs / effectiveWallMs : 0)}) | Helper Inference: ${formatDuration(analysis.helperInferenceMs)} (${formatPct(effectiveWallMs > 0 ? analysis.helperInferenceMs / effectiveWallMs : 0)}) | Tools: ${formatDuration(analysis.toolExecutionMs)} (${formatPct(effectiveWallMs > 0 ? analysis.toolExecutionMs / effectiveWallMs : 0)}) | Idle/In-flight: ${formatDuration(analysis.unaccountedWallMs)} (${formatPct(effectiveWallMs > 0 ? analysis.unaccountedWallMs / effectiveWallMs : 0)})`,
			`System Prompt: ${formatInt(analysis.systemPromptChars)} chars`,
			`User Prompt:   ${analysis.userPromptPreview}`,
		].join("\n"),
	);

	const modelRows = analysis.models.map((m) => [
		`${m.model} (${m.role})`,
		String(m.turns),
		`${m.toolCalls} (${m.toolErrors} err)`,
		m.callsPerTurn.toFixed(2),
		formatUsd(m.costTotalUsd),
		formatPct(m.costShare),
		formatUsd(m.costPerTurnUsd.avg),
		formatInt(m.inputTokens),
		formatInt(m.cacheReadTokens),
		formatInt(m.cacheWriteTokens),
		formatInt(m.outputTokens),
		formatPct(m.cacheHitRate),
		`${formatInt(m.peakContextTokens)}`,
	]);
	if (analysis.models.length > 1) {
		const totalInput = analysis.models.reduce((s, m) => s + m.inputTokens, 0);
		const totalCacheRead = analysis.models.reduce((s, m) => s + m.cacheReadTokens, 0);
		const totalCacheWrite = analysis.models.reduce((s, m) => s + m.cacheWriteTokens, 0);
		const totalOutput = analysis.models.reduce((s, m) => s + m.outputTokens, 0);
		const totalPrompt = totalInput + totalCacheRead + totalCacheWrite;
		modelRows.push([
			"TOTAL",
			String(analysis.totalTurns),
			`${analysis.totalToolCalls} (${analysis.totalToolErrors} err)`,
			(analysis.totalTurns > 0 ? analysis.totalToolCalls / analysis.totalTurns : 0).toFixed(2),
			formatUsd(analysis.totalCostUsd),
			"100.0%",
			formatUsd(analysis.totalTurns > 0 ? analysis.totalCostUsd / analysis.totalTurns : 0),
			formatInt(totalInput),
			formatInt(totalCacheRead),
			formatInt(totalCacheWrite),
			formatInt(totalOutput),
			formatPct(totalPrompt > 0 ? totalCacheRead / totalPrompt : 0),
			formatInt(Math.max(...analysis.models.map((m) => m.peakContextTokens))),
		]);
	}

	const costBreakdownLines = analysis.models.map(
		(m) =>
			`  • ${m.model} (${m.role}): in=${formatUsd(m.costInputUsd)} | cacheRead=${formatUsd(m.costCacheReadUsd)} | cacheWrite=${formatUsd(m.costCacheWriteUsd)} | out=${formatUsd(m.costOutputUsd)}${m.keepalivePings > 0 ? ` | keepalives=${m.keepalivePings} (${formatUsd(m.keepaliveCostUsd)})` : ""} | effIn=$${m.effectiveInputUsdPerM.toFixed(2)}/MTok | effOut=$${m.effectiveOutputUsdPerM.toFixed(2)}/MTok`,
	);

	if (analysis.withBaton && analysis.helperTurns > 0) {
		costBreakdownLines.push(
			`  • Counterfactual (if Lead ran all ${analysis.totalTurns} turns): ~${formatUsd(analysis.estimatedSingleModelLeadCostUsd)} vs actual ${formatUsd(analysis.totalCostUsd)} → est. saved ${formatUsd(analysis.estimatedSavingsUsd)} (${formatPct(analysis.estimatedSavingsRatio)})`,
		);
	}

	sections.push(
		[
			`── COST, TOKENS & PROMPT CACHE BY MODEL ──────────────────────────────────────`,
			renderTable(
				["Model", "Turns", "Calls", "Calls/T", "USD", "Share", "Avg/Turn", "In(Unc)", "CacheRead", "CacheWrite", "OutTok", "CacheHit", "PeakCtx"],
				modelRows,
				new Set([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
			),
			...costBreakdownLines,
		].join("\n"),
	);

	const latencyRows = analysis.models.map((m) => [
		`${m.model} (${m.role})`,
		String(m.turns),
		formatDuration(m.latencyMs.sum),
		formatDuration(m.latencyMs.min),
		formatDuration(m.latencyMs.avg),
		formatDuration(m.latencyMs.p50),
		formatDuration(m.latencyMs.p90),
		formatDuration(m.latencyMs.p95),
		formatDuration(m.latencyMs.max),
		`${m.outputTokensPerSec.avg.toFixed(1)} tok/s`,
		`${m.outputTokensPerSec.p50.toFixed(1)} tok/s`,
		`${formatInt(m.thinkingChars)} / ${formatInt(m.textChars)}`,
	]);

	sections.push(
		[
			`── LATENCY, THROUGHPUT & GENERATION STATS ────────────────────────────────────`,
			renderTable(
				["Model", "Turns", "TotalTime", "Min", "Avg", "p50", "p90", "p95", "Max", "AvgSpeed", "p50Speed", "Think/Text Chars"],
				latencyRows,
				new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
			),
		].join("\n"),
	);

	if (analysis.runs.length > 0) {
		const runRows = analysis.runs.map((r) => [
			`#${r.runNumber}`,
			r.finished ? "done" : "ACTIVE/KILLED",
			formatDuration(r.wallDurationMs),
			String(r.turns),
			`${r.toolCalls} (${r.toolErrors}e)`,
			formatUsd(r.costUsd),
			`${(r.turnLatencyMs.avg / 1000).toFixed(1)}s / ${(r.turnLatencyMs.max / 1000).toFixed(1)}s`,
			`${r.outputTokensPerSec.avg.toFixed(1)}`,
			`${formatInt(r.contextStartTokens)}→${formatInt(r.contextEndTokens)}`,
			r.noteChars !== undefined ? `${formatInt(r.noteChars)} (${formatPct(r.noteChars / 80_000)})` : "—",
			`${r.editedFiles.length} (${r.bashMutatedFiles.length} bash)`,
			r.leadReaction,
			oneLinePreview(r.stopReason, 38),
		]);

		const runDetails = analysis.runs.map((r) => {
			const lines = [
				`  Run #${r.runNumber} (${r.startedAtIso} → ${r.endedAtIso ?? "unfinished"}):`,
				`    Trigger Lead Calls: ${r.triggerLeadCalls.join(" ; ") || "(none)"}`,
				`    Stop Reason:        ${r.stopReason}`,
				`    Files (edit/write): ${r.noteFiles.length > 0 ? r.noteFiles.map((f) => `${f.kind} ${f.path} (+${f.added}/-${f.removed})`).join(", ") : r.editedFiles.join(", ") || "none"}`,
			];
			if (r.bashMutatedFiles.length > 0) {
				lines.push(`    Bash File Writes:   ${r.bashMutatedFiles.join(", ")} (WARNING: not tracked by baton_undo)`);
			}
			if (r.noteChars !== undefined) {
				lines.push(
					`    Note Delivery:      ${formatInt(r.noteChars)} chars | ${r.noteShownReadsCount} verbatim read(s) shown | ${r.noteOmittedReadsCount} omitted | ${r.noteDiffClippedCount} diff(s) clipped`,
				);
			}
			if (r.leadFollowupTurnIndex !== undefined) {
				lines.push(
					`    Lead Follow-up:     Turn #${r.leadFollowupTurnIndex} → reaction=${r.leadReaction.toUpperCase()} | gapSincePrevLead=${r.leadGapSincePrevLeadMs ? formatDuration(r.leadGapSincePrevLeadMs) : "n/a"} | cacheRead=${formatInt(r.leadFollowupCacheReadTokens ?? 0)} | cacheWrite=${formatInt(r.leadFollowupCacheWriteTokens ?? 0)} | cost=${formatUsd(r.leadFollowupCostUsd ?? 0)}`,
				);
			}
			if (r.leadSteeringNote) {
				lines.push(`    Lead Steering:      "Helper: ${r.leadSteeringNote}"`);
			}
			return lines.join("\n");
		});

		sections.push(
			[
				`── BATON SPECULATIVE RUNS (${analysis.runs.length}) ──────────────────────────────────────────────`,
				renderTable(
					["Run", "State", "WallTime", "Turns", "Calls", "Cost", "Avg/MaxTurn", "Tok/s", "Context", "NoteChars", "Files", "LeadAct", "StopReason"],
					runRows,
					new Set([2, 3, 4, 5, 6, 7, 8, 9, 10]),
				),
				...runDetails,
			].join("\n"),
		);
	}

	const toolRows = analysis.tools.map((t) => [
		t.name,
		String(t.totalCalls),
		String(t.leadCalls),
		String(t.helperCalls),
		`${t.errors} (${formatPct(t.errorRate)})`,
		formatDuration(t.durationMs.sum),
		formatDuration(t.durationMs.avg),
		formatDuration(t.durationMs.p95),
		formatDuration(t.durationMs.max),
		formatInt(t.totalOutputChars),
		formatInt(t.avgOutputChars),
	]);

	const bashRows = (Object.entries(analysis.bashBreakdown) as Array<[BashCategory, { calls: number; errors: number; pipedChecks: number }]>)
		.filter(([, stats]) => stats.calls > 0)
		.map(([category, stats]) => [category, String(stats.calls), String(stats.errors), String(stats.pipedChecks)]);

	sections.push(
		[
			`── TOOL CALLS & BASH BREAKDOWN ───────────────────────────────────────────────`,
			renderTable(
				["Tool", "Total", "Lead", "Helper", "Errors", "TotalTime", "AvgTime", "p95Time", "MaxTime", "OutputChars", "AvgChars"],
				toolRows,
				new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
			),
			...(bashRows.length > 0
				? [
						"",
						"Bash Sub-Categories:",
						renderTable(["Bash Category", "Calls", "Errors", "Piped Checks (| head/tail/grep)"], bashRows, new Set([1, 2, 3])),
					]
				: []),
		].join("\n"),
	);

	if (analysis.fileHotspots.length > 0) {
		const fileRows = analysis.fileHotspots.slice(0, 15).map((f) => [
			f.path,
			String(f.reads),
			String(f.writes),
			`${f.edits}${f.editErrors ? ` (${f.editErrors}e)` : ""}`,
			String(f.bashMutations),
			`${f.leadTouches}L / ${f.helperTouches}H`,
			f.addedLines || f.removedLines ? `+${f.addedLines} / -${f.removedLines}` : "—",
		]);
		sections.push(
			[
				`── FILE HOTSPOTS (TOP ${Math.min(15, analysis.fileHotspots.length)} OF ${analysis.fileHotspots.length}) ──────────────────────────────────────────`,
				renderTable(["File Path", "Reads", "Writes", "Edits", "BashMut", "Touches(L/H)", "RunNote Diff"], fileRows, new Set([1, 2, 3, 4, 5, 6])),
			].join("\n"),
		);
	}

	const timelineRows = analysis.timeline.map((seg, idx) => [
		String(idx + 1),
		seg.label,
		formatDuration(seg.durationMs),
		String(seg.turns),
		`${seg.toolCalls}${seg.toolErrors ? ` (${seg.toolErrors}e)` : ""}`,
		formatUsd(seg.costUsd),
		formatInt(seg.contextTokens),
		oneLinePreview(seg.summary, 65),
	]);

	sections.push(
		[
			`── SESSION TIMELINE (PHASES) ─────────────────────────────────────────────────`,
			renderTable(["#", "Phase / Segment", "Duration", "Turns", "Calls", "Cost", "CtxTok", "Summary"], timelineRows, new Set([0, 2, 3, 4, 5, 6])),
		].join("\n"),
	);

	const slowTurnRows = analysis.slowestTurns.map((t) => [
		`#${t.turnIndex}`,
		`${t.model} (${t.role}${t.runNumber ? ` R#${t.runNumber}` : ""})`,
		formatDuration(t.durationMs),
		formatInt(t.contextTokens),
		formatInt(t.outputTokens),
		`${t.outputTokensPerSec.toFixed(1)} tok/s`,
		formatUsd(t.costTotalUsd),
		oneLinePreview(t.toolCalls.map((c) => c.summary).join("; ") || `stop (${t.textChars} chars)`, 55),
	]);

	const slowCallRows = analysis.slowestToolCalls.map((c) => [
		`T#${c.turnIndex}`,
		`${c.role}${c.runNumber ? ` R#${c.runNumber}` : ""}`,
		c.name,
		formatDuration(c.durationMs),
		c.isError ? "ERROR" : "ok",
		formatInt(c.outputChars),
		oneLinePreview(c.summary, 65),
	]);

	sections.push(
		[
			`── SLOWEST MODEL TURNS & TOOL CALLS ──────────────────────────────────────────`,
			"Top 5 Slowest Model Turns:",
			renderTable(["Turn", "Model / Role", "Latency", "CtxTok", "OutTok", "Speed", "Cost", "Action"], slowTurnRows, new Set([2, 3, 4, 5, 6])),
			"",
			"Top 5 Slowest Tool Executions:",
			renderTable(["Turn", "Role", "Tool", "Duration", "Status", "OutChars", "Command / Target"], slowCallRows, new Set([3, 5])),
		].join("\n"),
	);

	if (analysis.diagnostics.length > 0) {
		const diagLines = analysis.diagnostics.map((d) => {
			const badge = d.severity === "critical" ? "[CRITICAL]" : d.severity === "warning" ? "[WARNING] " : "[INFO]    ";
			return `  ${badge} (${d.category}) ${d.message}`;
		});
		sections.push([`── DIAGNOSTICS & ANOMALIES (${analysis.diagnostics.length}) ──────────────────────────────────────────────`, ...diagLines].join("\n"));
	}

	if (options.showTurns) {
		const allTurnRows = analysis.turns.map((t) => [
			`#${t.turnIndex}`,
			t.role === "helper" ? `H(R#${t.runNumber ?? "?"})` : "Lead",
			(t.durationMs / 1000).toFixed(1) + "s",
			formatInt(t.contextTokens),
			formatInt(t.outputTokens),
			t.outputTokensPerSec.toFixed(1),
			formatUsd(t.costTotalUsd),
			`${t.thinkingChars}/${t.textChars}`,
			oneLinePreview(t.toolCalls.map((c) => `${c.name}${c.isError ? "!" : ""}(${c.target})`).join(", ") || t.stopReason, 65),
		]);
		sections.push(
			[
				`── ALL ASSISTANT TURNS (${analysis.turns.length}) ────────────────────────────────────────────────`,
				renderTable(["Turn", "Role", "Dur", "CtxTok", "OutTok", "Tok/s", "Cost", "Think/Txt", "Calls / Stop"], allTurnRows, new Set([2, 3, 4, 5, 6, 7])),
			].join("\n"),
		);
	}

	if (options.showCalls) {
		const allCallRows = analysis.turns.flatMap((t) =>
			t.toolCalls.map((c, idx) => [
				`T#${t.turnIndex}.${idx + 1}`,
				c.role === "helper" ? `H(R#${c.runNumber ?? "?"})` : "Lead",
				c.name,
				`${c.durationMs}ms`,
				c.isError ? "ERR" : "ok",
				formatInt(c.outputChars),
				oneLinePreview(c.summary, 75),
			]),
		);
		sections.push(
			[
				`── ALL TOOL CALLS (${allCallRows.length}) ────────────────────────────────────────────────────`,
				renderTable(["Call", "Role", "Tool", "Dur", "Status", "OutChars", "Summary"], allCallRows, new Set([3, 5])),
			].join("\n"),
		);
	}

	return sections.join("\n\n");
}

export function renderComparisonReport(analyses: SessionAnalysis[]): string {
	const headers = ["Metric", ...analyses.map((a) => `${a.sessionName} (${a.withBaton ? "Baton" : "Single"})`)];
	const rows: string[][] = [
		["Status", ...analyses.map((a) => (a.completedCleanly ? "Completed" : `Incomplete (${a.terminationSummary})`))],
		["Wall Duration", ...analyses.map((a) => formatDuration(a.runnerWallMs ?? a.transcriptWallMs))],
		["Total USD Cost", ...analyses.map((a) => formatUsd(a.totalCostUsd))],
		["Lead USD Cost", ...analyses.map((a) => `${formatUsd(a.leadCostUsd)} (${a.leadTurns} turns)`)],
		["Helper USD Cost", ...analyses.map((a) => `${formatUsd(a.helperCostUsd)} (${a.helperTurns} turns)`)],
		["Total Turns", ...analyses.map((a) => `${a.totalTurns} (${a.leadTurns}L / ${a.helperTurns}H)`)],
		["Total Tool Calls", ...analyses.map((a) => `${a.totalToolCalls} (${a.totalToolErrors} errors)`)],
		["Speculative Runs", ...analyses.map((a) => String(a.runs.length))],
		["Lead Inference Time", ...analyses.map((a) => formatDuration(a.leadInferenceMs))],
		["Helper Inference Time", ...analyses.map((a) => formatDuration(a.helperInferenceMs))],
		["Tool Execution Time", ...analyses.map((a) => formatDuration(a.toolExecutionMs))],
		[
			"Peak Context Tokens",
			...analyses.map((a) => formatInt(Math.max(0, ...a.models.map((m) => m.peakContextTokens)))),
		],
		[
			"Total Output Tokens",
			...analyses.map((a) => formatInt(a.models.reduce((sum, m) => sum + m.outputTokens, 0))),
		],
	];

	return [
		`══════════════════════════════════════════════════════════════════════════════`,
		` MULTI-SESSION COMPARISON (${analyses.length} runs)`,
		`══════════════════════════════════════════════════════════════════════════════`,
		renderTable(headers, rows),
	].join("\n");
}

function parseCliArgs(argv: string[]) {
	const paths: string[] = [];
	let json = false;
	let showTurns = false;
	let showCalls = false;
	let help = false;

	for (const arg of argv) {
		if (arg === "--json" || arg === "-j") json = true;
		else if (arg === "--turns" || arg === "-t") showTurns = true;
		else if (arg === "--calls" || arg === "-c") showCalls = true;
		else if (arg === "--all" || arg === "-a") {
			showTurns = true;
			showCalls = true;
		} else if (arg === "--help" || arg === "-h") help = true;
		else paths.push(arg);
	}

	return { paths, json, showTurns, showCalls, help };
}

function main() {
	const { paths, json, showTurns, showCalls, help } = parseCliArgs(process.argv.slice(2));
	if (help || paths.length === 0) {
		console.log(
			[
				"Usage: bun scripts/analyze-session.ts <session.jsonl | dir> [more-paths...] [options]",
				"",
				"Options:",
				"  --json,  -j   Output full structured statistics as JSON",
				"  --turns, -t   Include per-turn table in human output",
				"  --calls, -c   Include per-tool-call table in human output",
				"  --all,   -a   Include both per-turn and per-tool-call tables",
				"  --help,  -h   Show this help message",
			].join("\n"),
		);
		process.exit(help ? 0 : 1);
	}

	const sessionFiles = resolveSessionFiles(paths);
	const analyses = sessionFiles.map((filePath) => analyzeSessionFile(filePath));

	if (json) {
		console.log(JSON.stringify(analyses.length === 1 ? analyses[0] : analyses, null, 2));
		return;
	}

	for (const analysis of analyses) {
		console.log(renderHumanReport(analysis, { showTurns, showCalls }));
		console.log("");
	}

	if (analyses.length > 1) {
		console.log(renderComparisonReport(analyses));
	}
}

const isExecutedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isExecutedDirectly) {
	main();
}

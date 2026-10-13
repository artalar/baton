/** Baton 0.9 Jev config (no imports: shared by switch-core and jev-policy without an import cycle). */
export interface JevThresholds {
	/** block if max(weakens_checks, tampers_env) ≥ block */
	block: number;
	/** allow + handoff to the lead if max(weakens, tampers) ∈ [review, block) */
	review: number;
	/** allow + handoff if P(gate = allow_handoff) ≥ handoff */
	handoff: number;
	/** allow + handoff (and GLM → lead at a turn boundary) if stuck ≥ stuck */
	stuck: number;
	/** lead → helper if routine_ahead ≥ routine and ≥ minNonWrite consecutive non-write calls */
	routine: number;
	minNonWrite: number;
}
export interface JevConfig {
	enabled: boolean;
	model: string;
	/** Same API, one field changed; tried after a primary error/timeout/invalid answer. */
	fallbackModel?: string;
	/** Per attempt. */
	timeoutMs: number;
	recentCalls: number;
	clipChars: number;
	/** Gate every helper tool call. */
	gateCalls: boolean;
	/** Ask at every turn boundary (routine_ahead for the lead, stuck for the helper). */
	gateTurns: boolean;
	/** Helper rewrites the short text part of the summary every N turns (0 = off). */
	summaryEveryTurns: number;
	summaryChars: number;
	/** Jev-initiated lead → helper read rounds (separate from maxFollowups). */
	maxRoutineHandoffs: number;
	thr: JevThresholds;
}
export const DEFAULT_JEV: JevConfig = {
	enabled: true,
	model: "typesafe/jev-1.13",
	fallbackModel: "microsoft/microsoft-decision-1",
	timeoutMs: 800,
	recentCalls: 5,
	clipChars: 220,
	gateCalls: true,
	gateTurns: true,
	summaryEveryTurns: 10,
	summaryChars: 300,
	maxRoutineHandoffs: 3,
	thr: { block: 0.8, review: 0.5, handoff: 0.8, stuck: 0.9, routine: 0.6, minNonWrite: 2 },
};


/** Turn-boundary answers passed to decideTurn. */
export interface TurnJev {
	routine: number;
	stuck: number;
	phase?: string;
}

export type CallKind = "read" | "verify" | "write" | "other";
export interface RecentCall {
	model: string;
	kind: CallKind;
	summary: string;
	err: boolean;
	tail: string;
}

/** Rolling summary: counters computed by code + a short text the helper rewrites every ~N turns. */
export interface JevTrack {
	task: string;
	toolCalls: number;
	writes: number;
	filesWritten: string[];
	consecutiveNonWrite: number;
	lastCheck: "none" | "passed" | "FAILED";
	tests: "none" | "passed" | "FAILED";
	nodeModulesChanged: boolean;
	/** Short text (≤ summaryChars) by the helper; overwritten, never appended. */
	text: string;
	textTurn: number;
	recent: RecentCall[];
	routineHandoffs: number;
}
export const initialTrack = (task = ""): JevTrack => ({ task: task.slice(0, 400), toolCalls: 0, writes: 0, filesWritten: [], consecutiveNonWrite: 0, lastCheck: "none", tests: "none", nodeModulesChanged: false, text: "", textTurn: 0, recent: [], routineHandoffs: 0 });


import { type JournalEvent, eventLine, normPath } from "./journal.ts";

/** Minimal structural view of pi's AgentMessage that masking needs. */
export interface MsgLike {
	role: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	[k: string]: unknown;
}

export interface MaskOptions {
	enabled: boolean;
	exemptTools: string[];
	dedupReads: boolean;
	staleReads: boolean;
	cwd: string;
}

export interface MaskStats {
	masked: number;
	deduped: number;
	stale: number;
	charsSaved: number;
}

type Lookup = (toolCallId: string) => JournalEvent | undefined;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: unknown }).text ?? "") : "")).join("\n");
}

export function stubText(kind: "masked" | "duplicate" | "stale", toolName: string, e: JournalEvent | undefined, ref?: number): string {
	const head = e ? eventLine(e) : `${toolName} (no journal record)`;
	const recall = e ? ` baton_recall({"evt":${e.evt}}) returns the full output.` : "";
	if (kind === "duplicate") return `[baton: duplicate read, superseded by evt#${ref}. ${head}.${recall}]`;
	if (kind === "stale") return `[baton: stale read, file changed at evt#${ref}. ${head}.${recall}]`;
	return `[baton: output masked. ${head}.${recall}]`;
}

/**
 * Pure. Returns new messages where:
 * - every tool result that the model has already answered (i.e. followed by an assistant
 *   message) is replaced by a stub that references its evt#;
 * - earlier reads of the same file/range are replaced by "duplicate" stubs;
 * - reads followed by a write/edit of the same file are replaced by "stale" stubs.
 * Results of the current, unanswered batch stay visible (unless duplicate/stale).
 * The session itself is not modified: pi only applies this to the outgoing request.
 */
export function maskMessages<T extends MsgLike>(messages: readonly T[], lookup: Lookup, opts: MaskOptions): { messages: T[]; stats: MaskStats } {
	const stats: MaskStats = { masked: 0, deduped: 0, stale: 0, charsSaved: 0 };
	if (!opts.enabled) return { messages: [...messages], stats };

	// toolCallId -> arguments, from assistant tool calls
	const args = new Map<string, Record<string, unknown>>();
	let lastAssistant = -1;
	messages.forEach((m, i) => {
		if (m.role !== "assistant") return;
		lastAssistant = i;
		if (!Array.isArray(m.content)) return;
		for (const c of m.content as Array<Record<string, unknown>>) {
			if (c?.type === "toolCall" && typeof c.id === "string") args.set(c.id, (c.arguments as Record<string, unknown>) ?? {});
		}
	});

	const pathOf = (a: Record<string, unknown> | undefined) => {
		const p = a && (typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : undefined);
		return p ? normPath(p, opts.cwd) : undefined;
	};
	const evtOf = (m: T, i: number) => (m.toolCallId ? lookup(m.toolCallId) : undefined)?.evt ?? -(i + 1);

	// latest read index per (path, range) and latest write index per path
	const lastRead = new Map<string, number>();
	const writesAfter = new Map<string, number[]>();
	messages.forEach((m, i) => {
		if (m.role !== "toolResult" || !m.toolCallId) return;
		const a = args.get(m.toolCallId);
		const p = pathOf(a);
		if (!p) return;
		if (m.toolName === "read") lastRead.set(`${p}#${a?.offset ?? ""}:${a?.limit ?? ""}`, i);
		if (m.toolName === "write" || m.toolName === "edit") writesAfter.set(p, [...(writesAfter.get(p) ?? []), i]);
	});

	const out = messages.map((m, i) => {
		if (m.role !== "toolResult") return m;
		const name = m.toolName ?? "tool";
		if (opts.exemptTools.includes(name)) return m;
		const e = m.toolCallId ? lookup(m.toolCallId) : undefined;
		const a = m.toolCallId ? args.get(m.toolCallId) : undefined;
		let stub: string | undefined;
		if (name === "read") {
			const p = pathOf(a);
			if (p) {
				const key = `${p}#${a?.offset ?? ""}:${a?.limit ?? ""}`;
				const later = lastRead.get(key);
				const w = (writesAfter.get(p) ?? []).find((wi) => wi > i);
				if (opts.staleReads && w !== undefined) {
					stub = stubText("stale", name, e, evtOf(messages[w]!, w));
					stats.stale++;
				} else if (opts.dedupReads && later !== undefined && later > i) {
					stub = stubText("duplicate", name, e, evtOf(messages[later]!, later));
					stats.deduped++;
				}
			}
		}
		if (!stub && i < lastAssistant) {
			stub = stubText("masked", name, e);
			stats.masked++;
		}
		if (!stub) return m;
		const before = textOf(m.content).length;
		if (before <= stub.length && !/(duplicate|stale)/.test(stub)) {
			// tiny output: masking would not save anything; keep it
			stats.masked--;
			return m;
		}
		stats.charsSaved += Math.max(0, before - stub.length);
		return { ...m, content: [{ type: "text", text: stub }] } as T;
	});
	return { messages: out, stats };
}

import { isSameModel } from "./config.ts";

export const HELPER_INSTRUCTION_TYPE = "baton-helper";
export const LEAD_NOTE_TYPE = "baton-lead";

export interface ContextMessage {
	role: string;
	content?: unknown;
	model?: string;
	toolCallId?: string;
	customType?: string;
	timestamp?: number;
	[key: string]: unknown;
}

type ContentBlock = { type: string; id?: string; text?: string; thinking?: string };

const originalLeadMessages = new WeakMap<ContextMessage, ContextMessage>();

const toolCallIds = (message: ContextMessage): string[] =>
	((Array.isArray(message.content) ? message.content : []) as ContentBlock[]).flatMap((block) => (block.type === "toolCall" && block.id ? [block.id] : []));

function extractLeadThinking<T extends ContextMessage>(message: T): T {
	const source = (originalLeadMessages.get(message) as T | undefined) ?? message;
	if (!Array.isArray(source.content)) return source;
	const blocks = source.content as ContentBlock[];
	if (!blocks.some((block) => block.type === "thinking")) return source;
	const content = blocks.flatMap((block) => {
		if (block.type !== "thinking") return [block];
		return block.thinking?.trim() ? [{ type: "text", text: block.thinking }] : [];
	});
	const extracted = { ...source, content } as T;
	originalLeadMessages.set(extracted, source);
	return extracted;
}

function restoreLeadThinking<T extends ContextMessage>(message: T): T {
	return (originalLeadMessages.get(message) as T | undefined) ?? message;
}

/**
 * Filters a transcript for one model.
 * - The lead sees no helper turns and no helper instructions: each finished run is one harness note instead.
 *   Removing whole messages only appends to what the lead saw before, so its prompt cache stays valid.
 * - The helper sees the lead's view (with lead thinking extracted to text) plus the turns and instruction of the current run (`currentRunStartedAt`).
 */
export function viewFor<T extends ContextMessage>(messages: readonly T[], helperModel: string, currentRunStartedAt?: number): T[] {
	const isCurrentRun = (message: ContextMessage) => currentRunStartedAt !== undefined && (message.timestamp ?? 0) >= currentRunStartedAt;
	const hiddenToolCalls = new Set<string>();
	const visible: T[] = [];
	for (const message of messages) {
		const isHelperTurn = message.role === "assistant" && isSameModel(message.model, helperModel);
		if (isHelperTurn && !isCurrentRun(message)) {
			for (const id of toolCallIds(message)) hiddenToolCalls.add(id);
			continue;
		}
		if (message.role === "custom" && message.customType === HELPER_INSTRUCTION_TYPE && !isCurrentRun(message)) continue;
		if (message.role === "toolResult" && message.toolCallId && hiddenToolCalls.has(message.toolCallId)) continue;
		const isLeadTurn = message.role === "assistant" && !isHelperTurn;
		if (isLeadTurn) {
			visible.push(currentRunStartedAt !== undefined ? extractLeadThinking(message) : restoreLeadThinking(message));
			continue;
		}
		visible.push(message);
	}
	return visible;
}

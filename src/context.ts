import { isSameModel } from "./config.ts";

export const ALERT_TYPE = "baton-alert";

export interface ContextMessage {
	role: string;
	content?: unknown;
	model?: string;
	toolCallId?: string;
	customType?: string;
	timestamp?: number;
	sections?: Record<string, string | null>;
	[key: string]: unknown;
}

type ContentBlock = { type: string; id?: string; text?: string; thinking?: string };

export type ViewRole = "lead" | "follower";

const toolCallIds = (message: ContextMessage): string[] =>
	((Array.isArray(message.content) ? message.content : []) as ContentBlock[]).flatMap((block) => (block.type === "toolCall" && block.id ? [block.id] : []));

const isFollowerTurn = (message: ContextMessage, helperModel: string) => message.role === "assistant" && isSameModel(message.model, helperModel);

const isAlert = (message: ContextMessage) => message.role === "custom" && message.customType === ALERT_TYPE;

function withoutThinking<T extends ContextMessage>(message: T): T {
	if (!Array.isArray(message.content)) return message;
	const blocks = message.content as ContentBlock[];
	if (!blocks.some((block) => block.type === "thinking")) return message;
	return { ...message, content: blocks.filter((block) => block.type !== "thinking") };
}

/**
 * One stored transcript, filtered per model.
 * The lead sees each alert where the follower's tool work sits, and not that work's raw messages or the follower's thinking.
 * The follower sees the lead's messages, including thinking, the real tool calls and results, and user messages. Alerts and the follower's own thinking are left out.
 * Filtering only drops or trims messages, so an alert stays at one index and later lead turns keep the same prefix.
 */
export function viewFor<T extends ContextMessage>(messages: readonly T[], helperModel: string, role: ViewRole): T[] {
	if (role === "follower") {
		return messages.flatMap((message) => {
			if (isAlert(message)) return [];
			if (isFollowerTurn(message, helperModel)) return [withoutThinking(message)];
			return [message];
		});
	}
	const hiddenToolCalls = new Set<string>();
	const visible: T[] = [];
	for (const message of messages) {
		if (isFollowerTurn(message, helperModel)) {
			for (const id of toolCallIds(message)) hiddenToolCalls.add(id);
			continue;
		}
		if (message.role === "toolResult" && message.toolCallId && hiddenToolCalls.has(message.toolCallId)) continue;
		visible.push(message);
	}
	return visible;
}

/** Appends the role's sentences as one system section, leaving the base prompt in place. */
export function projectSystemPrompt<T extends ContextMessage>(messages: readonly T[], note: string): T[] {
	let lastSystem = -1;
	for (let index = 0; index < messages.length; index++) {
		if (messages[index]?.role === "system") lastSystem = index;
	}
	if (lastSystem < 0) return [{ role: "system", content: "", sections: { baton: note } } as unknown as T, ...messages];
	return messages.map((message, index) => {
		if (index !== lastSystem) return message;
		const sections = { ...(message.sections ?? {}), baton: note };
		return { ...message, sections };
	});
}

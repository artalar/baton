import { createHash } from "node:crypto";

/**
 * Conservative chars-per-token ratio. Real tokenizers give ~3.5-4 chars/token for English prose
 * but ~2.8-3.4 for code, JSON and non-Latin text (e.g. Russian), so chars/4 under-counts the packs
 * Baton sends. 3.2 keeps the pack budget safe for mixed code + prose.
 */
export const CHARS_PER_TOKEN = 3.2;

/** Conservative token estimate used everywhere in Baton: chars / 3.2, plus extra weight for non-ASCII. */
export function estimateTokens(text: string): number {
	let nonAscii = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) nonAscii++;
	// Non-ASCII chars (Cyrillic, CJK, emoji) cost roughly one token per 1-2 chars: count them twice.
	return Math.ceil((text.length + nonAscii) / CHARS_PER_TOKEN);
}

/** Inverse of estimateTokens for ASCII text: how many chars fit into `tokens`. */
export function charsForTokens(tokens: number): number {
	return Math.floor(tokens * CHARS_PER_TOKEN);
}

/** Minimal glob → RegExp: `**` (any depth), `*` (no slash), `?`. Anchored, POSIX separators. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				const slash = glob[i + 2] === "/";
				re += slash ? "(?:.*/)?" : ".*";
				i += slash ? 2 : 1;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
	}
	return new RegExp(`^${re}$`);
}

/** True when the (relative or absolute) path matches any of the globs. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
	const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
	return globs.some((g) => globToRegExp(g).test(p));
}

export function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Keep the first `head` and last `tail` lines; mark the cut. */
export function headTail(text: string, head: number, tail: number): string {
	const lines = text.split("\n");
	if (lines.length <= head + tail) return text;
	const cut = lines.length - head - tail;
	return [...lines.slice(0, head), `… [${cut} lines cut] …`, ...lines.slice(lines.length - tail)].join("\n");
}

/** Hard character cap that keeps the start and the end. */
export function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const half = Math.max(0, Math.floor((maxChars - 30) / 2));
	return `${text.slice(0, half)}\n… [${text.length - 2 * half} chars cut] …\n${text.slice(text.length - half)}`;
}

export function oneLine(text: string, max = 200): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

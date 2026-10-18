#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg_json="$root/package.json"

if [[ ! -f "$root/dist/index.js" ]]; then
	printf 'compiled dist entry is missing; run bun run build first\n' >&2
	exit 1
fi

pkg_name="$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).name)" "$pkg_json")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pack_dir="$tmp/pack"
mkdir -p "$pack_dir"
(
	cd "$root"
	npm pack --json --pack-destination "$pack_dir" >"$tmp/pack-meta.json"
)
tarball="$(node -e '
const text = require("node:fs").readFileSync(process.argv[1], "utf8");
const filename = JSON.parse(text.slice(text.indexOf("[")))[0].filename;
process.stdout.write(filename.startsWith("/") ? filename : process.argv[2] + "/" + filename);
' "$tmp/pack-meta.json" "$pack_dir")"

consumer="$tmp/consumer"
mkdir -p "$consumer" "$tmp/agent"
(
	cd "$consumer"
	npm init -y >/dev/null
	npm install --no-fund --no-audit "$tarball" >/dev/null
	env -u BATON_LEAD -u BATON_HELPER -u BATON_SPEC -u BATON_HELPER_THINKING -u BATON_MAX_TURNS -u BATON_CACHE_KEEPALIVE_MS -u BATON_JOURNAL_DIR \
		PI_CODING_AGENT_DIR="$tmp/agent" \
		PKG_NAME="$pkg_name" \
		node --input-type=module <<'JS'
const pkg = await import(process.env.PKG_NAME);
const extension = pkg.default;
if (typeof extension !== "function") throw new Error("default export is not an extension factory");

const splitModel = (ref) => {
	const slash = ref.indexOf("/");
	if (slash <= 0) throw new Error("model ref is not provider/id: " + ref);
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
};
const lead = splitModel(pkg.DEFAULT_CONFIG.lead);
const helper = splitModel(pkg.DEFAULT_CONFIG.helper);

const tools = [];
const handlers = new Map();
const ctx = {
	cwd: process.cwd(),
	hasUI: false,
	model: undefined,
	sessionManager: { getSessionId: () => "smoke-session" },
	modelRegistry: { find: (provider, id) => ({ provider, id }) },
};
extension({
	on(event, handler) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		return () => {};
	},
	registerTool(tool) {
		tools.push(tool.name);
	},
	getThinkingLevel: () => "medium",
	setThinkingLevel() {},
	async setModel(next) {
		ctx.model = { provider: next.provider, id: next.id };
		return true;
	},
});
if (tools.includes("baton_undo")) throw new Error("baton_undo is still registered");

const emit = async (event, payload) => {
	let result;
	for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
	return result;
};
const sameModel = (actual, expected) => actual?.provider === expected.provider && actual?.id === expected.id;

await emit("session_start", {});
await emit("before_agent_start", { messageType: "user", prompt: "smoke", systemPrompt: "", systemPromptOptions: {} });
if (!sameModel(ctx.model, lead)) throw new Error("lead was not selected: " + JSON.stringify(ctx.model));

const leadTurn = await emit("turn_end", {
	message: {
		role: "assistant",
		model: lead.id,
		stopReason: "toolUse",
		content: [{ type: "toolCall", id: "lead-1", name: "read", arguments: { path: "README.md" } }],
	},
	toolResults: [{ toolCallId: "lead-1", isError: false, content: [{ type: "text", text: "LEAD_FILE" }] }],
});
if (leadTurn !== undefined) throw new Error("a lead tool turn should switch without an alert");
if (!sameModel(ctx.model, helper)) throw new Error("follower was not selected: " + JSON.stringify(ctx.model));

const followerWork = await emit("turn_end", {
	message: {
		role: "assistant",
		model: helper.id,
		stopReason: "toolUse",
		content: [
			{ type: "thinking", thinking: "SECRET_PLAN" },
			{ type: "toolCall", id: "helper-1", name: "bash", arguments: { command: "echo smoke" } },
		],
	},
	toolResults: [{ toolCallId: "helper-1", isError: false, content: [{ type: "text", text: "FOLLOWER_FILE" }] }],
});
if (followerWork !== undefined) throw new Error("a follower tool turn should stay on the follower");
if (!sameModel(ctx.model, helper)) throw new Error("follower left during its tool turn");

const back = await emit("turn_end", {
	message: { role: "assistant", model: helper.id, stopReason: "stop", content: [{ type: "text", text: "done" }] },
	toolResults: [],
});
if (!back?.continue) throw new Error("follower handback did not continue the lead");
const entry = back.entries?.[0];
if (entry?.customType !== "baton-alert") throw new Error("missing alert: " + JSON.stringify(entry));
const alert = String(entry.content);
if (!alert.includes("bash") || !alert.includes("FOLLOWER_FILE")) throw new Error("alert is missing the follower tool record");
if (alert.includes("SECRET_PLAN") || alert.includes("LEAD_FILE")) throw new Error("alert includes text the lead should not see");
if (!sameModel(ctx.model, lead)) throw new Error("lead did not return: " + JSON.stringify(ctx.model));
JS
)

printf 'smoke ok: %s\n' "$pkg_name"

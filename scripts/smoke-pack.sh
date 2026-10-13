#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg_json="$root/package.json"

if [[ ! -f "$root/dist/index.js" ]]; then
	printf 'compiled dist entry is missing; run bun run build first\n' >&2
	exit 1
fi

pkg_name="$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).name)" "$pkg_json")"
typebox_spec="$(node -e "const pkg=JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); process.stdout.write('typebox@'+pkg.devDependencies.typebox)" "$pkg_json")"

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
mkdir -p "$consumer"
(
	cd "$consumer"
	npm init -y >/dev/null
	npm install --no-fund --no-audit "$tarball" "$typebox_spec" >/dev/null
	node --input-type=module -e "
const extension = (await import('$pkg_name')).default;
if (typeof extension !== 'function') throw new Error('default export is not an extension factory');
const tools = [];
const events = new Set();
extension({ on: (event) => { events.add(event); return () => {}; }, registerTool: (tool) => tools.push(tool.name), setModel: async () => true });
for (const event of ['before_agent_start', 'turn_end', 'context', 'tool_call', 'message_end']) if (!events.has(event)) throw new Error('missing handler: ' + event);
if (!tools.includes('baton_undo')) throw new Error('baton_undo is not registered');
"
)

printf 'smoke ok: %s\n' "$pkg_name"

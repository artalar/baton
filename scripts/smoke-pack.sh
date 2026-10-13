#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pkg_json="$root/package.json"

if [[ ! -f "$root/dist/cli/baton-pack.js" || ! -f "$root/dist/cli/baton-review.js" || ! -f "$root/dist/core/index.js" ]]; then
	printf 'compiled dist entries are missing; run bun run build first\n' >&2
	exit 1
fi

pkg_name="$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).name)" "$pkg_json")"
import_specifier="$(node -e "process.stdout.write(JSON.stringify(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).name))" "$pkg_json")"
typebox_spec="$(node -e "const pkg=JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); process.stdout.write('typebox@'+pkg.devDependencies.typebox)" "$pkg_json")"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pack_dir="$tmp/pack"
mkdir -p "$pack_dir"
pack_meta="$tmp/pack-meta.json"
(
	cd "$root"
	npm pack --json --pack-destination "$pack_dir" >"$pack_meta"
)
tarball="$(node -e '
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[1], "utf8");
const parsed = JSON.parse(text.slice(text.indexOf("[")));
const filename = parsed[0].filename;
process.stdout.write(filename.startsWith("/") ? filename : process.argv[2] + "/" + filename);
' "$pack_meta" "$pack_dir")"

if [[ ! -f "$tarball" ]]; then
	printf 'npm pack did not write %s\n' "$tarball" >&2
	exit 1
fi

consumer="$tmp/consumer"
mkdir -p "$consumer"
(
	cd "$consumer"
	npm init -y >/dev/null
	npm install --no-fund --no-audit "$tarball" "$typebox_spec"
)

repo="$tmp/repo"
mkdir -p "$repo"
git -C "$repo" init -b main >/dev/null
git -C "$repo" config user.email "smoke@example.com"
git -C "$repo" config user.name "smoke"
git -C "$repo" config commit.gpgsign false
mkdir -p "$tmp/no-hooks"
git -C "$repo" config core.hooksPath "$tmp/no-hooks"
printf 'hello\n' >"$repo/file.txt"
git -C "$repo" add file.txt
git -C "$repo" commit -m "init" >/dev/null
printf 'changed\n' >>"$repo/file.txt"

baton_pack="$consumer/node_modules/.bin/baton-pack"
baton_review="$consumer/node_modules/.bin/baton-review"

set +e
pack_stdout="$(env -u OPENROUTER_API_KEY "$baton_pack" --cwd "$repo" "smoke task" 2>"$tmp/pack.err")"
pack_status=$?
set -e
if [[ "$pack_status" -ne 0 ]]; then
	printf 'baton-pack exited %s\n' "$pack_status" >&2
	cat "$tmp/pack.err" >&2
	exit 1
fi
if [[ "$pack_stdout" != *"<baton_pack"* ]]; then
	printf 'baton-pack stdout missing <baton_pack marker\n%s\n' "$pack_stdout" >&2
	exit 1
fi

(
	cd "$consumer"
	node -e 'import('"$import_specifier"').then(m=>{if(!m.buildReviewPack)process.exit(1)})'
)

set +e
review_output="$(env -u OPENROUTER_API_KEY "$baton_review" smoke 2>&1)"
review_status=$?
set -e
if [[ "$review_status" -eq 0 ]]; then
	printf 'baton-review exited 0 without OPENROUTER_API_KEY\n%s\n' "$review_output" >&2
	exit 1
fi
if [[ "$review_output" == *"ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING"* || "$review_output" == *"ERR_MODULE_NOT_FOUND"* || "$review_output" == *"Cannot find module"* ]]; then
	printf 'baton-review failed while loading modules\n%s\n' "$review_output" >&2
	exit 1
fi
if [[ "$review_output" != *"OPENROUTER_API_KEY is not set"* ]]; then
	printf 'baton-review did not report the missing API key\n%s\n' "$review_output" >&2
	exit 1
fi

printf 'smoke ok: %s\n' "$pkg_name"

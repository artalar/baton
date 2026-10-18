#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

if [[ $# -ne 1 ]]; then
	printf 'usage: %s <name>\n' "$0" >&2
	exit 1
fi

name="$1"

run() {
	printf '+'
	printf ' %q' "$@"
	printf '\n'
	"$@"
}

run bun evals/reatom-2048/prepare.mjs --name "$name"
run bun evals/reatom-2048/harness/run.mjs --name "$name" --prompt evals/reatom-2048/prompt.txt --budget 3 --baton 0 --delegate 1

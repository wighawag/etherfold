#!/usr/bin/env bash
# Repeat ONE vitest case many times, optionally under CPU contention, and count failures.
#
# Bounded on purpose (CONTEXT.md, and the task that wrote this): at most `nproc - 2`
# vitest processes at once, at most `nproc - 2` CPU burners, every vitest run under
# `timeout`, every burner under `timeout`, and every child killed on exit.
#
# Usage (from anywhere; run `pnpm install && pnpm build` at the repo root first):
#   docs/spikes/the-frozen-leader-takeover-flake/repro.sh [options]
#
# Options (environment variables):
#   ITERATIONS=200   how many vitest runs in total
#   PARALLEL=8       vitest runs at once (clamped to nproc - 2)
#   BURNERS=0        CPU burners (busy loops) running for the whole measurement (clamped to nproc - 2)
#   FILE=...         the test file, relative to packages/browser
#                    (default: test/aVisibleTabTakesTheLeaseFromABackgroundedLeader.test.ts)
#   NAME=FROZEN      the `-t` pattern (default: the FROZEN leader case)
#   RUN_TIMEOUT=120  seconds each vitest run may take
#   OUT=...          where logs go (default: a fresh directory under /tmp; never inside the repo)
#   PATCH=           apply one of this folder's patches for the run and REVERSE it on exit:
#                      trace          temporary instrumentation: every run prints an ordered FFL-TRACE
#                                     of lock grants, writer claims, the fresh start and the advance
#                      decide-widen   the new leader's createState takes 50 ms longer (test side only)
#                      decide-wait    the test waits for the fresh start before advancing (test side only)
#                    The patch must apply cleanly to the tree as it is, or the script refuses to run.
#   KEEP_PASSING=0   1 keeps the logs of passing runs too (with PATCH=trace, their traces)
#
# Output: one line per run (pass/FAIL), then a summary line
#   runs=<n> failures=<n> rate=<pct>% parallel=<p> burners=<b>
# and, for every failing run, its full log in $OUT/run-<i>.log.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
pkg="$repo/packages/browser"

cores="$(nproc)"
cap=$((cores > 2 ? cores - 2 : 1))
ITERATIONS="${ITERATIONS:-200}"
PARALLEL="${PARALLEL:-8}"
BURNERS="${BURNERS:-0}"
FILE="${FILE:-test/aVisibleTabTakesTheLeaseFromABackgroundedLeader.test.ts}"
NAME="${NAME:-FROZEN}"
RUN_TIMEOUT="${RUN_TIMEOUT:-120}"
PATCH="${PATCH:-}"
KEEP_PASSING="${KEEP_PASSING:-0}"
OUT="${OUT:-$(mktemp -d /tmp/frozen-leader-flake.XXXXXX)}"
((PARALLEL > cap)) && PARALLEL=$cap
((BURNERS > cap)) && BURNERS=$cap
mkdir -p "$OUT"

vitest="$pkg/node_modules/.bin/vitest"
[[ -x "$vitest" ]] || { echo "no $vitest: run 'pnpm install && pnpm build' at the repo root first" >&2; exit 2; }

patched=""
if [[ -n "$PATCH" ]]; then
	patch_file="$here/$PATCH.patch"
	[[ -f "$patch_file" ]] || { echo "no patch $patch_file" >&2; exit 2; }
	(cd "$repo" && patch -p1 --dry-run --silent <"$patch_file") || { echo "$PATCH.patch does not apply cleanly; refusing" >&2; exit 2; }
	(cd "$repo" && patch -p1 --silent --no-backup-if-mismatch <"$patch_file")
	patched="$patch_file"
fi

burner_pids=()
cleanup() {
	for pid in "${burner_pids[@]}"; do kill "$pid" 2>/dev/null || true; done
	# vitest runs still going when interrupted
	jobs -p | xargs -r kill 2>/dev/null || true
	wait 2>/dev/null || true
	# The patch goes LAST, once nothing is running against the patched tree.
	if [[ -n "$patched" ]]; then
		(cd "$repo" && patch -R -p1 --silent --no-backup-if-mismatch <"$patched") || echo "WARNING: could not reverse $patched" >&2
		patched=""
	fi
}
trap cleanup EXIT INT TERM

# The burners outlive the measurement by nothing: each is killed on exit, and each has
# its own hard stop in case this script is killed with -9.
for ((b = 0; b < BURNERS; b++)); do
	timeout 3600 node -e 'for(;;){}' &
	burner_pids+=($!)
done

run_one() {
	local i="$1" log="$OUT/run-$1.log"
	if (cd "$pkg" && timeout "$RUN_TIMEOUT" "$vitest" run "$FILE" -t "$NAME" >"$log" 2>&1); then
		echo "run $i pass"
		[[ "$KEEP_PASSING" == 1 ]] || rm -f "$log"
	else
		echo "run $i FAIL"
	fi
}

started=$(date +%s)
for ((i = 1; i <= ITERATIONS; i++)); do
	while (($(jobs -rp | wc -l) - BURNERS >= PARALLEL)); do sleep 0.05; done
	run_one "$i" >>"$OUT/results.txt" &
done
# wait for the vitest runs only (not the burners)
while (($(jobs -rp | wc -l) > BURNERS)); do sleep 0.2; done

failures=$(grep -c FAIL "$OUT/results.txt" || true)
runs=$(wc -l <"$OUT/results.txt")
rate=$(awk -v f="$failures" -v r="$runs" 'BEGIN { printf "%.1f", r ? 100 * f / r : 0 }')
summary="runs=$runs failures=$failures rate=${rate}% parallel=$PARALLEL burners=$BURNERS cores=$cores seconds=$(($(date +%s) - started)) name=$NAME patch=${PATCH:-none}"
echo "$summary" | tee "$OUT/summary.txt"
echo "logs: $OUT"
if ((failures > 0)); then
	echo "first failure:"
	grep -h -m3 -E 'Error|AssertionError|DEMOTED' "$OUT"/run-*.log | head -3
fi

#!/usr/bin/env bash
# Serve worker.mjs on the workerd the repo already installs, fetch it once, stop it.
# Run from this folder after `pnpm install` at the repository root. Uses 127.0.0.1:18787.
set -euo pipefail
cd "$(dirname "$0")"
W=$(find ../../../node_modules/.pnpm -path '*workerd-linux-64*' -type f -name workerd | head -1)
"$W" --version
timeout 40 "$W" serve config.capnp & PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
for _ in $(seq 1 20); do sleep 0.5; if OUT=$(curl -sf -m 5 http://127.0.0.1:18787/); then echo "$OUT"; exit 0; fi; done
echo "workerd did not answer" >&2; exit 1

#!/usr/bin/env bash
# What ends up in a processor bundle's BYTES, and therefore in its identity.
#
# A processor is named by the sha256 of the bundle (ADR-0086), so every flag that
# changes the output changes which generation a deployment is. Three questions
# decided the documented command, and each is answered here by hashing real
# esbuild output rather than by reading the documentation:
#
#   1. does the building machine's DIRECTORY LAYOUT reach the bytes? (un-minified)
#   2. does `--minify` remove it? (the reason the flag is mandatory)
#   3. do SOURCE MAPS move the identity, and does the spelling matter?
#
# It builds ONE source twice, from two different working directories, which is
# the developer-versus-CI case: the same checkout, reached by a different
# relative path.
#
# Run it from anywhere; it needs an `esbuild` on the PATH or in `ESBUILD`, and it
# writes only to a scratch directory it makes and removes.
#
#   ESBUILD=packages/utils/node_modules/.bin/esbuild \
#     docs/spikes/the-build-command-and-its-pinning-rule-are-documented/measure-what-lands-in-the-bytes.sh

set -euo pipefail

# Resolved to an ABSOLUTE path, because the two builds below run from different
# working directories and that is the whole point of the measurement.
ESBUILD="$(readlink -f "$(command -v "${ESBUILD:-esbuild}")")"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/etherfold-bundle-identity-XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# ONE source, in a nested directory, so the two builds below differ ONLY in how
# far above the entry the bundler was invoked.
mkdir -p "$scratch/checkout/src"
cat >"$scratch/checkout/src/abi.js" <<'EOF'
export const abi = [{type: 'event', name: 'Transfer'}];
EOF
cat >"$scratch/checkout/src/entry.js" <<'EOF'
import {abi} from './abi.js';
export const createProcessor = () => ({entities: [], abi});
EOF

out="$scratch/out"
mkdir -p "$out"

# `from-above` is the repository root; `from-within` is the package directory.
# Both name the SAME file.
build() {
	local cwd="$1" entry="$2" name="$3"
	shift 3
	(cd "$cwd" && "$ESBUILD" "$entry" --bundle --format=esm "$@" --outfile="$out/$name.js" >/dev/null 2>&1)
}

build "$scratch/checkout" src/entry.js plain-from-above
build "$scratch/checkout/src" entry.js plain-from-within
build "$scratch/checkout" src/entry.js minified-from-above --minify
build "$scratch/checkout/src" entry.js minified-from-within --minify
build "$scratch/checkout/src" entry.js minified-sourcemap-linked --minify --sourcemap
build "$scratch/checkout/src" entry.js minified-sourcemap-external --minify --sourcemap=external

echo "esbuild $("$ESBUILD" --version), $(uname -s) $(date -u +%Y-%m-%d)"
echo
echo "sha256 of each bundle:"
(cd "$out" && sha256sum ./*.js | sed 's|\./||')
echo
echo "what the un-minified output opens with, built from above:"
head -2 "$out/plain-from-above.js"
echo "...and built from within:"
head -2 "$out/plain-from-within.js"
echo
echo "what a LINKED source map appends to the bundle:"
tail -c 40 "$out/minified-sourcemap-linked.js"

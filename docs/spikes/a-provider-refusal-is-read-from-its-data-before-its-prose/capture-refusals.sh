#!/usr/bin/env bash
# Re-capture what public endpoints answer when an eth_getLogs range is too big.
#
# The numbers and shapes in
# work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md are
# per-provider and per-plan, and providers revise them. Run this before trusting
# any single capture, and paste the output next to a dated header in
# refusal-shapes.md.
#
#   bash docs/spikes/a-provider-refusal-is-read-from-its-data-before-its-prose/capture-refusals.sh
#
# Each probe asks for an unfiltered range far wider than any public cap, so a
# node that bounds the method REFUSES rather than answers. No API key is used:
# every endpoint here is keyless, which is the case the fetcher must survive.

set -u

probe() {
	local name="$1" url="$2" from="${3:-0x100000}" to="${4:-0x1100000}"
	local body
	body=$(timeout 20 curl -s -X POST "$url" -H 'content-type: application/json' \
		-d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getLogs\",\"params\":[{\"fromBlock\":\"$from\",\"toBlock\":\"$to\"}]}" |
		head -c 600)
	printf '%-22s %-56s %s\n' "$name" "$url" "${body:-<no response>}"
}

echo "# captured $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

echo "## structured data: the hint is in error.data, not (only) in the message"
probe gnosis https://rpc.gnosischain.com 0x1000000 0x1100000
probe gnosis-chiado https://rpc.chiadochain.net
probe fraxtal https://rpc.frax.com
probe ronin https://api.roninchain.com/rpc
echo

echo "## -32000: a generic code carrying a range complaint"
probe polygon-zkevm https://zkevm-rpc.com
probe pulsechain https://rpc.pulsechain.com
probe merlin https://rpc.merlinchain.io
probe immutable https://rpc.immutable.com
probe arbitrum-one https://arb1.arbitrum.io/rpc
probe arbitrum-nova https://nova.arbitrum.io/rpc
probe cronos https://evm.cronos.org
probe kava https://evm.kava.io
probe avalanche https://api.avax.network/ext/bc/C/rpc 0x3000000 0x3100000
probe flare https://flare-api.flare.network/ext/C/rpc
probe sonic https://rpc.soniclabs.com
probe harmony https://api.harmony.one
echo

echo "## -32602 and friends: the codes the parser already knows"
probe mevblocker https://rpc.mevblocker.io 0x18B0000 0x18BB950
probe 1rpc https://1rpc.io/eth 0x18B0000 0x18BB950
probe publicnode https://ethereum-rpc.publicnode.com
probe zksync-era https://mainnet.era.zksync.io
probe abstract https://api.mainnet.abs.xyz
probe celo https://forno.celo.org
probe linea https://rpc.linea.build
probe mantle https://rpc.mantle.xyz
probe base https://mainnet.base.org
probe bsc https://bsc-dataseed.bnbchain.org
probe alchemy-public https://eth-mainnet.g.alchemy.com/public
probe blastapi https://eth-mainnet.public.blastapi.io 0x18B0000 0x18BB950
probe cloudflare https://cloudflare-eth.com 0x18B0000 0x18BB950

# Re-verified refusal shapes, 2026-09-08

The captures behind `work/notes/findings/what-nodes-answer-when-a-getlogs-range-is-too-big.md` are dated 2026-06-30 and sourced from SQD, who sell a competing product. The finding itself says to re-run the probes before trusting any single number. This is that re-run, made independently against 60+ keyless public endpoints; `capture-refusals.sh` in this directory reproduces the 30 that mattered, and the raw output is below.

Everything here is an unfiltered `eth_getLogs` over a range far wider than any public cap, so a node that bounds the method refuses rather than answers.

## What held, and what moved

**Held.** The `publicnode` archive refusal is verbatim identical, code and text, three months on: `-32602`, `"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"`. It mentions neither `results` nor `block range`, so it is still exactly the case `looksLikeRangeHint` earns its keep on. 1rpc still caps at 50 blocks. There is still no portable page size, and the two KINDS of cap (block span, result count) are still both live.

**Moved.** `rpc.mevblocker.io` no longer produces the `-32005` + `data: {from, limit, to}` shape the finding quotes. It now enforces a 10,000-BLOCK span cap and answers `-32602 "range 47440 exceeds limit of 10000"`, and its result-count refusal could not be provoked at all (narrower spans answered `-32603 "service temporarily unavailable"`). `eth.merkle.io` no longer serves `eth_getLogs` at all (`-32601 "Method not found"`).

So the STRUCTURED `data: {from, limit, to}` shape is no longer reproducible on the endpoint the finding names. It is still a real provider response: the durable citation is the verbatim Infura body in [ethers-io/ethers.js#4703](https://github.com/ethers-io/ethers.js/issues/4703), which is what the tests use and quote.

```json
{"jsonrpc":"2.0","id":47,"error":{"code":-32005,"data":{"from":"0xBDE5F8","limit":10000,"to":"0x102DBCC"},"message":"query returned more than 10000 results. Try with this block range [0xBDE5F8, 0x102DBCC]."}}
```

## What the re-run ADDED

**A second structured shape, live on four endpoints, whose hint is 100% discarded today.** Nethermind puts the whole hint in `data` as a STRING and leaves the message generic:

```json
{"code":-32602,"message":"invalid params","data":"Query returned more than 50000 results. Try with this block range [0x1000000, 0x1080000]."}
```

The message is `"invalid params"`, so `looksLikeRangeHint` rejects it and the bracketed pair sitting in `data` is never looked at. Gnosis, Gnosis Chiado and Fraxtal all answer this way; Ronin answers the same shape without a bracketed pair. This is the sharpest live instance of "read `error.data` before the prose" that exists today, and it is the one the finding did not have.

**`-32000` really is a range code, on at least eleven endpoints.** Confirmed: Polygon zkEVM, PulseChain, Merlin and Immutable all state a range complaint that PASSES the existing hint gate; Arbitrum One, Arbitrum Nova, Xai, Cronos, Kava, Avalanche, Flare, Sonic and Harmony state one that does not.

**But no reachable `-32000` carries a machine-readable suggestion.** Across every endpoint probed, not one `-32000` carried a bracketed `[0x…, 0x…]` pair or a structured `data` descriptor. Every real `-32000` range refusal states its cap in PROSE only ("max range: 10000", "maximum is set to 2048", "limit of 10000"). Extracting that stated number is user story 3 of the spec and a different task; under THIS task's two mechanisms a `-32000` therefore still yields no range and still falls back to halving. The widening is what lets the hint be read at all when a provider does supply one, and it is what story 3 will build on.

**`-32000` needs the gate as much as `-32602` does.** Cronos and Kava answer `-32000 "maximum [from, to] blocks distance: 2000"` — a bracketed pair that is not a range at all. That is the negative case for the widened code, and it is real rather than invented.

**Shapes nobody reads yet, recorded for the cap-extraction task.** `-32600` with a bracketed suggestion (Alchemy's public endpoint, blastapi), `-32614` (Base, Optimism, Blast, Berachain), `-32701` (publicnode's own span cap), `-32062` (Scroll, Etherlink), `-32047` (Cloudflare), `-32012` with a nested `data.details.maxAllowedRange` (Taiko), and drpc's plan refusal at code `35`.

## Raw output

```
# captured 2026-09-08T17:49:44Z

## structured data: the hint is in error.data, not (only) in the message
gnosis                 https://rpc.gnosischain.com                              {"id":1,"jsonrpc":"2.0","error":{"code":-32602,"message":"invalid params","data":"Query returned more than 50000 results. Try with this block range [0x1000000, 0x1080000]."}}
gnosis-chiado          https://rpc.chiadochain.net                              {"id":1,"jsonrpc":"2.0","error":{"code":-32602,"message":"invalid params","data":"Query returned more than 50000 results. Try with this block range [0x100000, 0x8dec64]."}}
fraxtal                https://rpc.frax.com                                     {"id":1,"jsonrpc":"2.0","error":{"code":-32602,"message":"invalid params","data":"Query returned more than 20000 results. Try with this block range [0x100000, 0x81dfec]."}}
ronin                  https://api.roninchain.com/rpc                           {"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params","data":"requested block range 16777217 exceeds the limit of 200; narrow your fromBlock/toBlock"},"id":1}

## -32000: a generic code carrying a range complaint
polygon-zkevm          https://zkevm-rpc.com                                    {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"block range too large, max range: 10000"}}
pulsechain             https://rpc.pulsechain.com                               {"jsonrpc":"2.0","id":1,"result":null,"error":{"code":-32000,"message":"query returned more than allowed number of logs, try with smaller block range"}}
merlin                 https://rpc.merlinchain.io                               {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"block range too large, max range: 2000"}}
immutable              https://rpc.immutable.com                                {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"exceeded maximum block range: 5000"}}
arbitrum-one           https://arb1.arbitrum.io/rpc                             {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"logs matched by query exceeds limit of 10000"}}
arbitrum-nova          https://nova.arbitrum.io/rpc                             {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"logs matched by query exceeds limit of 10000"}}
cronos                 https://evm.cronos.org                                   {"id":1,"error":{"code":-32000,"message":"maximum [from, to] blocks distance: 2000","data":null},"jsonrpc":"2.0"}
kava                   https://evm.kava.io                                      {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"maximum [from, to] blocks distance: 10000"}}
avalanche              https://api.avax.network/ext/bc/C/rpc                    {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"requested too many blocks from 50331648 to 51380224, maximum is set to 2048"}}
flare                  https://flare-api.flare.network/ext/C/rpc                {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"requested too many blocks from 1048576 to 17825792, maximum is set to 30"}}
sonic                  https://rpc.soniclabs.com                                {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"too wide blocks range, the limit is 100"}}
harmony                https://api.harmony.one                                  {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"GetLogs query must be smaller than size 1024"}}

## -32602 and friends: the codes the parser already knows
mevblocker             https://rpc.mevblocker.io                                {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"range 47440 exceeds limit of 10000"}}
1rpc                   https://1rpc.io/eth                                      {"jsonrpc":"2.0","error":{"code":-32602,"message":"eth_getLogs is limited to 0 - 50 blocks range"},"id":1}
publicnode             https://ethereum-rpc.publicnode.com                      {"jsonrpc":"2.0","error":{"code":-32602,"message":"Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"},"id":1}
zksync-era             https://mainnet.era.zksync.io                            {"jsonrpc":"2.0","error":{"code":-32602,"message":"Query returned more than 10000 results. Try with this block range [0x100000, 0x1000bb]."},"id":1}
abstract               https://api.mainnet.abs.xyz                              {"jsonrpc":"2.0","error":{"code":-32602,"message":"Query returned more than 10000 results. Try with this block range [0x100000, 0x1001b6]."},"id":1}
celo                   https://forno.celo.org                                   {"jsonrpc":"2.0","error":{"code":-32602,"message":"query exceeds range, retry smaller (max block range 5000, got 16777216)"},"id":1}
linea                  https://rpc.linea.build                                  {"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"range 16777216 exceeds limit of 10000"}}
mantle                 https://rpc.mantle.xyz                                   {"jsonrpc":"2.0","error":{"code":-32602,"message":"block range greater than 10000 max"},"id":1}
base                   https://mainnet.base.org                                 {"jsonrpc":"2.0","error":{"code":-32614,"message":"eth_getLogs is limited to a 10,000 range"},"id":1}
bsc                    https://bsc-dataseed.bnbchain.org                        {"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"limit exceeded"}}
alchemy-public         https://eth-mainnet.g.alchemy.com/public                 {"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"You can make eth_getLogs requests with up to a 100 block range. Based on your parameters, this block range should work: [0x100000, 0x100063]"}}
blastapi               https://eth-mainnet.public.blastapi.io                   {"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"You can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x18b0000, 0x18b0009]"}}
cloudflare             https://cloudflare-eth.com                               {"jsonrpc":"2.0","error":{"code":-32047,"message":"Invalid eth_getLogs request. 'fromBlock'-'toBlock' range too large. Max range: 800"},"id":1}
```

Endpoints probed and dropped from the script because they answered with an infrastructure error rather than a refusal on 2026-09-08: `eth.llamarpc.com` (525), `ethereum.blockpi.network` (521), `endpoints.omniatech.io` (521), `rpc.flashbots.net` (504), `eth.merkle.io` (`-32601`, method gone), `rpc.ankr.com/*` (key required), `polygon-rpc.com` (tenant disabled).

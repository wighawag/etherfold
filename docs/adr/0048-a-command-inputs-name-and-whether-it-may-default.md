# Every command input has ONE name, and only the port may default

> **AMENDED 2026-09-26 (ADR-0085): the table has a SIXTH row, `upload`, and two inputs only it owns.** Read the amendment at the end.
>
> **AMENDED 2026-09-26 (ADR-0093): `run`'s processor and source may be absent TOGETHER, as a MODE rather than a default.** Read the second amendment at the end.

Every `etherfold` command resolves every input through one module (`packages/cli/src/config.ts`): a FLAG first, then the ONE environment variable behind it, then a REFUSAL that names both — never a default. The exception is the port, which falls back to `2000`, and it is the only one. The variables are the ones a deployable already publishes — the fetcher host's `INDEXING_SOURCE`, `ETH_NODE_URI`, `INGEST_ENDPOINT`, `INGEST_TOKEN`, `REQUESTS_PER_SECOND` and the Node server host's `DB`, `PORT` — and the CLI's own second name for the node URL (`ETHEREUM_NODE`) is retired, because two names for one input is how two deployments of one image end up meaning different things.

## Why only the port

Because a port is not a claim about the deployment: a wrong one fails visibly and at once, nothing is written to the wrong place, and every HTTP tool in existence already has a conventional value. Every other input fails SILENTLY when it is wrong. A defaulted database is the sharpest case and the one this rule exists for: a `serve` that quietly opened `./etherfold.db` answers, healthily, about nothing, and a `build` that quietly wrote one has produced an artifact nobody can find. A defaulted node URL indexes the wrong chain. A defaulted store enforces a retention window nobody asked for. So the general rule is a refusal, and each default has to earn itself against "what does it look like when this is wrong and nobody notices?".

The asymmetry that makes this worth recording rather than obvious: **adding a default later is free and removing one is breaking.** A deployment that came to rely on `--db` defaulting cannot have it taken away without a migration, so the direction to be wrong in is the strict one.

## Why some inputs have no variable at all

Six do and six do not, and the line is deliberate: **the environment carries what varies between deployments of ONE image** — the chain, the source, the database, the wire, the port — while a flag carries **what the image IS**: which processor module, which store, which retention window, which interface to bind. So `-p`, `--store`, `--retention`, `-d`, `--host` and `--no-auto-setup` are flags only, and a refusal for one of them says so rather than naming a variable that does not exist. Inventing `PROCESSOR` or `STORE` would have been a second way to say something a container's `CMD` already says.

## Why a flag a command does not own is REFUSED, and an ambient variable is not

An accepted-and-ignored flag is a deployment believing something untrue, so `etherfold serve -p ./processor.js` is refused with the reason a read tier holds no processor, not accepted and dropped, and not left to commander's `unknown option` — which names neither a reason nor the command that does own the input. The refused flags are therefore REGISTERED (hidden from `--help`) so that they parse and reach the resolver, which is where the reason lives. That is what makes moving between the five commands a deployment change rather than a rewrite: the flags that do not move say where they went.

An ambient VARIABLE a command does not own is a different case and is simply not read. One host runs `fetch` beside `index`, so `ETH_NODE_URI` being set while `index` runs is ordinary; refusing on it would make the split deployment this system exists for impossible to configure.

## Consequences

- Requiredness cannot live in the argument parser, because a `requiredOption` refuses without naming the variable behind it. It lives in `resolveCommandConfig`, so every refusal is a function a test calls over an options object and an environment record.
- A commander DEFAULT is likewise forbidden, and not merely discouraged: a flag that is always present can never fall back to the variable behind it. `--port`'s parser default had silently made `PORT` unreachable.
- The requiredness of all five commands lives in ONE table, so the three commands that do not exist yet consume this rather than extend it.

## Amendment, 2026-09-26 (ADR-0085): a sixth command, `upload`, and the inputs of a CLIENT

"The requiredness of all five commands lives in ONE table" is now six. `etherfold upload` sends an already-built bundle to a running node's admin upload route, and it takes its inputs exactly as the five deployment commands take theirs: through `resolveCommandConfig`, from the one ownership table, flag first and environment behind it, refusing rather than defaulting, and refusing every flag it does not own with the reason and the place that input lives. It is not a deployment intent (it runs nothing; it is a CLIENT of a node that is running), which is why its row takes almost nothing the others do: the chain, the source, the database, the port and the promotion policy all belong to the node it addresses.

What it adds:

- **Two inputs, owned by `upload` alone and refused (hidden from help) on the other five.** `--to <url>` / **`UPLOAD_TO`**, the running node's base URL, deliberately a NEW name rather than `-n` / `ETH_NODE_URI`, which means the CHAIN's JSON-RPC endpoint on every command that takes it; reusing it would let one variable point a pipeline's `build` at a chain and its `upload` at the same URL. And `--admin-token <token>` / **`ADMIN_TOKEN`**, the credential it presents, under the name the node's admin guard already reads (ADR-0057), with the same "prefer the variable" note `--ingest-token` carries. The three commands that SERVE the admin surface (`run`, `index`, `serve`) keep reading `ADMIN_TOKEN` from their environment in the HTTP layer as before; the FLAG is refused there, since a checked secret has no business on a command line.
- **`--indexer` is REQUIRED on `upload` and never defaulted**, although `run` and `build` default it (ADR-0052): the sender ADDRESSES a route by the name, which is exactly the routing use ADR-0036 forbids defaulting, and a defaulted name would deploy to the wrong indexer without a word.
- **The bundle is the `processor` input**, required, and it takes a POSITIONAL spelling on this one command (`etherfold upload ./dist/processor.js`), since the file is the whole of what the command is about; `-p` names the same input there too so a copied command line resolves, and naming it both ways is refused rather than resolved by precedence.
- **`-n` / `ETH_NODE_URI` is refused as a FLAG and ignored as an ambient variable**, under this ADR's own asymmetry: a CI job that also runs `build` has `ETH_NODE_URI` set, and it is never read as the upload target.

The rule about which inputs get a variable holds: the target node and the credential vary between deployments of one pipeline, so both have one.

## Amendment, 2026-09-26 (ADR-0093): `run` may be started with nothing configured, and waits

This ADR says a missing input is a REFUSAL and never a default, because a defaulted input fails silently. ADR-0093 makes ONE exception, and it is not a default: **`etherfold run` may be started with no processor and no source, together.** Nothing is filled in for either. The node does what its database says: it folds the registry's canonical generation from the bundle stored for it (ADR-0092) where it can, and otherwise it serves, fetches nothing, answers reads with the `503 no-canonical-generation` a fresh deployment answers (ADR-0058), and says on `/status` that it is WAITING for a processor (`cursor.waiting`). That is the loud failure this ADR asks every input to have, which is why the exception passes the test it sets ("what does it look like when this is wrong and nobody notices?": a waiting node says so on the page an operator watches).

What changed in the table, and what did not:

- **`run`'s processor is `optional` in `OWNERSHIP`, and only the PAIR may be absent** (`resolveRunProcessor`, `config.ts`). A processor with no source stays valid, as before: its module supplies the contracts. A SOURCE with no processor is still REFUSED, naming both ways out (add `--processor`, or give neither and wait for an upload), because contracts with nothing to fold them are a configuration error rather than an intent to wait, and a waiting node would otherwise drop the source an operator configured in favour of the contracts its first upload carries.
- **Every other command still requires what it required.** `build` and `index` fold at once and have nothing to wait on. The split `index` does not get the mode at all (ADR-0093): its fetcher is another process, which an upload cannot reach.
- **No variable is added**, and the rule about which inputs have one holds: the absence of `-p` is not an input, it is a mode, and nothing about it varies between deployments of one image.

# A `run` node may start with NO processor, and waits for one to be uploaded

> **AMENDED 2026-09-26 (`an-uploaded-processor-survives-a-restart`):** how a CONFIGURED processor relates to what was uploaded is now decided; see the amendment at the end.

> **AMENDED 2026-09-26 (`a-successor-on-a-new-stream-is-fetched-by-its-own-writer`):** a `run` no longer holds ONE fetcher over ONE source set once: every stream a held fold reads is fetched, and what `fetchedSource` names follows the pointer; see the second amendment at the end.

The Graph's deploy UX starts from a node with nothing configured: deployments ARRIVE. ADR-0085's amendment of 2026-09-22 makes that the target, and code retention (ADR-0092) makes it reachable, because a generation's bundle is stored with it and can be instantiated at open. We decide that **`etherfold run` may be started with no processor and no source.** Such a node runs whatever its registry's canonical generation names; if it has never received a processor, it WAITS for one to be uploaded. This is not a default: ADR-0048 refuses a missing input because a defaulted one fails silently, and a waiting node fails loudly by saying it is waiting.

## What a node with nothing configured does

- **With a canonical generation in its registry**, it instantiates that generation from its stored bundle and folds, exactly as a restart does under ADR-0092. The contracts it indexes are the ones that bundle carries.
- **With none**, it serves, fetches nothing, and says so: reads answer "no generation yet", the same shape as a fresh deployment before its first fold, and `/status` reports that the node is waiting for a processor. The first upload becomes its first generation and takes `canonical` by the registry's existing rule.
- **Every upload carries its own contracts** (ADR-0085's amendment), so a node with nothing configured always learns WHAT to index from the same artifact that says HOW to fold it.

## Why `run` and nothing else

`run` holds both halves in one process, the fetcher and the fold, so a source that arrives inside an upload reaches the thing that fetches. In a SPLIT deployment the fetcher is a separate `fetch` process configured with its source, and an upload to `index` cannot change what it fetches. So a split deployment does not get the waiting mode. What it may get later is uploads whose contracts MATCH what its fetcher already fetches, with a mismatch refused by name, which is the same match rule an upload to any node with a known source follows.

## Considered options

**Default the processor to something.** Rejected for ADR-0048's own reason: a defaulted processor folds something nobody chose and looks healthy doing it.

**Require the processor at start and let uploads only REPLACE it.** Rejected as the whole answer: it keeps The Graph's second half and loses its first, where a node is stood up once and processors arrive by deploy. A node started WITH a processor still works exactly as today.

**Let a split deployment's `index` accept any upload and re-configure the fetcher.** Rejected: the fetcher is another process, possibly on another machine, holding no processor by ADR-0003. Reaching back into it is a control channel this project has deliberately not built.

## Consequences

**ADR-0048 gains one exception, stated as a MODE rather than a default.** `run`'s processor and source may be absent together. Everything else keeps today's behaviour: a processor with no source is already valid (its module supplies the contracts), and a SOURCE with no processor is still refused, because contracts with nothing to fold them are a configuration error rather than an intent to wait.

**The match rule applies to UPLOADS.** Where a node was started with a source the operator configured at start (`--deployments` or `INDEXING_SOURCE`) and an upload's contracts differ from it, the upload is refused by name. A node whose source came from its processor module, or that was started with nothing, takes an upload carrying different contracts as a successor on a new stream, as a re-read after a filter change already is.

_Corrected in place on 2026-09-26, under ADR-FORMAT's rule for text that never described code._ This paragraph first said an upload is refused where "a node has a known source". No code ever implemented that wording, and the maintainer decided on 2026-09-26 that a source changes legitimately (a new event a new handler needs, an upgraded contract with new events), so the only source an upload is held to is one the operator configured. "A known source" would also have covered a source a node learned from its own processor module, which would refuse the ordinary "add an event" deploy; it is corrected rather than preserved so the next reader does not build that refusal. The route that implements the rule is `POST /{indexer}/admin/upload` (`packages/cli/src/upload.ts`).

On the disk path, a configured source today still OVERRIDES a module's own contract data (flag, then `INDEXING_SOURCE`, then the module); whether that should also become a match check is not decided here.

**It was built on two things that came first**: stored bytes and instantiation at open (ADR-0092), and the upload route itself (ADR-0085). _This sentence was corrected on 2026-09-26, when the mode landed: it used to say those two were unbuilt, which stopped being true with them._

**Where it lives.** `etherfold run` resolves no processor and the processor-module source origin (`resolveRunProcessor`, `packages/cli/src/config.ts`), and refuses a source with no processor there. The container is opened with no generation and no source (`ReceivingIndexerOptions.generation` and `.source` are optional, `@etherfold/core`): `open` registers nothing of its own and instantiates the registry's canonical generation from its stored bundle, where the host's instantiation names the source that bundle carries (`openWaitingFolding`, `packages/cli/src/folding.ts`). What the deployment fetches is `ReceivingIndexer.fetchedSource`: the configured source, or the source its FIRST fold carried, set once. The one fetcher is built late, by the drive loop, the first time that answer exists (`prepareWaiting`, `packages/cli/src/index.ts`), and until then `/status` carries `cursor.waiting: {for: 'processor', message}` (`WaitingReport`, `@etherfold/server`). _Changed by the second amendment of 2026-09-26: `fetchedSource` no longer stays set once, and the fetcher is no longer one._

## Amendment, 2026-09-26 (`an-uploaded-processor-survives-a-restart`, ADR-0084): a configured processor is an arrival, and an upload survives a restart

The Consequences above say what a node started with NOTHING configured does, and "Require the processor at start" says only that a node started WITH one "still works exactly as today". That left open how a configured processor relates to what was uploaded to the same database, and the maintainer decided it on 2026-09-26:

- **An upload survives a restart, including one still catching up.** A node instantiates the generation `successor` names at open as well as the canonical one (ADR-0092's amendment of the same day), so an upload that had not caught up when the process stopped goes on catching up after the restart and is promoted under the node's policy. This holds with nothing configured and with a configured processor alike.
- **A configured `--processor` is an ARRIVAL like any other.** Where it names a processor different from the canonical generation's, it registers as the new `successor`, and the promotion policy decides from there. Where it names the canonical generation, or the successor already pending, it changes nothing: a node restarted with the processor it was first started with keeps folding whatever was uploaded to it since.
- **A START may not SILENTLY replace a different pending successor**, whatever it arrived by (ADR-0084's amendment). An interactive start asks, naming both generations; a non-interactive one is refused by name unless `--override` is given. The re-read and the upload replace a pending successor as they always did.

So story 10 of `a-processor-artifact-is-pushed-to-a-running-deployment` ("an upload survives a restart") has exactly ONE exception: the operator restarts with a DIFFERENT configured processor AND confirms replacing the pending upload, by answering yes or by passing `--override`.

## Amendment, 2026-09-26 (`a-successor-on-a-new-stream-is-fetched-by-its-own-writer`, ADR-0087): the "add an event" upload completes

"Where it lives" above described the code until this change: `fetchedSource` was the configured source or the FIRST fold's, set once and never moved, and the one fetcher was built over it. So a node took an upload carrying different contracts as a successor on a new stream (as the Consequences say) and then never fetched that stream; it never caught up, was never promoted, and a restart fetched the canonical generation's stream again. The maintainer decided on 2026-09-26 for a second writer (ADR-0087's amendment of the same day), so now:

- **A `run` fetches every stream a fold it holds reads**, one fetcher per stream (`ReceivingIndexer.fetchedStreams`, `StreamFetchers` in `packages/cli/src/fetchers.ts`). A node started with nothing configured builds them late exactly as it built its one fetcher (`prepareWaiting`): it WAITS until the container names a stream, and `/status` says so until then.
- **What `fetchedSource` names follows the pointer** on a node started with nothing configured: a promotion onto a generation on another stream makes that generation's source the one it names, which is also what a restart finds, since `open` takes it from the canonical generation. It is the source a fold that names none defaults to, and no longer the whole of what is fetched.
- **A node whose source came from its PROCESSOR MODULE instantiates a stored generation over the contracts its OWN bundle carries**, as a node started with nothing configured always did (`sourceCarriedByBundle`, `openFolding`). Without it, a restart of the node that took the upload, with the processor it was first started with, would freeze the canonical generation the upload was promoted to, and would leave a new-stream successor still catching up unfetched. A source the OPERATOR configured still overrides a module's contract data on every path, so on such a node a stored generation on another stream stays frozen, as a filter change's always was. Such a node refuses an upload whose source differs (decision 2), so the only arrival that can put a successor on a new stream there is a re-read after the operator changed the configured source; that successor is held and its stream fetched like any other.
- **The incumbent stops being folded at a promotion onto another stream only on a `run` or a `build`**, which tell the container they fetch their own streams (`fetchesItsOwnStreams`, passed from `openFolding` and `openWaitingFolding`), so the old stream's fetcher can stop.
- **The split deployment is unchanged**: its fetcher is another process, and `index` still waits for what that process sends. It passes no `fetchesItsOwnStreams`, so after a promotion onto another stream its incumbent goes on folding and its stream goes on accepting pushes, as on every push-fed receiver (the server package's hosts too).

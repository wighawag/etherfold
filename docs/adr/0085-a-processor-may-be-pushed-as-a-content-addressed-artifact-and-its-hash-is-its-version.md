# A processor may be PUSHED as a content-addressed artifact, and the artifact's hash IS its version

> **AMENDED 2026-09-22: the pushed route is UN-DEFERRED, and the amendment at the end says what it now includes.** The decision below stands; what changed is WHEN to build the upload and what surrounds it.

A processor is code, so `an-endpoint-triggers-a-reconfigure-in-a-running-process` made the reconfigure endpoint a RE-READ rather than a receive: it re-resolves the configuration, re-imports the module from the filesystem behind a cache-busting URL query, and registers whatever generation that names. We propose to record that a processor may ALSO be pushed to a running deployment as a pre-bundled, content-addressed ARTIFACT, instantiated without touching the filesystem, with the hash of the received bytes serving as the processor's `version`.

## Why the re-read shape is not the end of the story

"A processor is code and cannot cross HTTP" is true of a module OBJECT and false of a module's BYTES. The Graph has shipped the pushed shape for years: a subgraph's mappings are AssemblyScript compiled to WASM (`language: wasm/assemblyscript`), referenced by a manifest, content-addressed through IPFS. Ponder, which is otherwise our closest neighbour (a TypeScript module, loaded by a framework, folding chain data into SQL), has gone the other way and provides NO production update surface at all: its reserved routes are `/health`, `/ready`, `/status` and `/metrics`, `ponder start` builds once and ignores file changes, and a changed processor reaches production by starting a new process in a new database schema and flipping a set of views.

So the field has two answers and we have taken a third. The re-read is better than Ponder's (a running deployment can pick up a change at all) and weaker than The Graph's (the change must already be on the deployment's filesystem, which a browser tab does not have and a remote deployment reaches only through whatever put the file there).

## What being BYTES buys, and why WASM is not what buys it

Three properties fall out of an artifact and none of them require WASM:

- **No filesystem.** The artifact arrives in the request, so a deployment with no disk, no deployments folder and no processor path can still be reconfigured. This is the shape a Node process has when the build cannot write to it: a container running a published image, or a server CI cannot reach the disk of. It is NOT a shape a Cloudflare Worker can use, because a Worker refuses every in-isolate route from bytes to running code (`work/notes/findings/a-worker-cannot-instantiate-a-processor-from-bytes.md`, ADR-0091), and a browser tab can use it only through a service worker (`work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md`).
- **No cache breaker.** Distinct bytes are a distinct module by construction, so the `?etherfold-reload=` query, which exists only to defeat Node's ESM registry, becomes unnecessary on this path. A `data:text/javascript;base64,...` URL in Node is instantiated without the loader ever consulting a path.

_Corrected in place on 2026-09-22, under ADR-FORMAT's amendment rule._ These two bullets first named a Worker and a browser tab as runtimes this shape serves, with a `blob:` URL as the browser's route. Neither was ever measured, and neither ever described the code: measured since, a Worker refuses `import(data:)`, `import(blob:)`, `new Function` and `eval` alike, and a realistic Content-Security-Policy refuses a `blob:` or `data:` module import in every engine. They are corrected rather than preserved, because keeping them would teach the next reader a runtime capability that does not exist.
- **Identity for free, and identity of the RIGHT thing.** The hash of the received bytes is a `version` that changes when and only when the artifact changes. Because the artifact is BUILD OUTPUT, comments and formatting are already gone, so it has neither the false positives of hashing source text (which is what Ponder does: it hashes `readFileSync` of each indexing file, so a comment edit triggers a full reindex) nor the false negatives of a hand-declared version (where an edited handler names the generation the deployment already holds).

What WASM buys beyond this is SANDBOXING, and that is a MULTI-TENANCY requirement rather than an indexing one. The Graph needs it because an indexer runs other people's subgraphs and must not let a mapping reach the host. A self-hosted etherfold deployment accepting an upload on the ADMIN credential is accepting code the operator already trusts, and the sandbox buys nothing there while costing a restricted language, no arbitrary npm, every capability crossing a host-function boundary (so no viem inside a handler), worse debugging, and a rewritten processor API.

## Considered options

**Compile the processor to WASM.** Rejected above: it pays a language and API rewrite for an isolation property a single-tenant deployment does not need. Reconsider if etherfold ever hosts processors it did not author, which is precisely the condition that made The Graph choose it.

**Keep re-read as the only shape.** It cannot serve a deployment with no filesystem, and it makes the identity depend on a `version` the author must arrange to generate, which is a step nothing verifies.

**Accept an unbundled module and resolve its imports on the deployment.** Rejected: it drags a resolver and a dependency graph across the wire and reintroduces the filesystem through the back door.

## The browser needs none of this, which is what confirms the shape

A browser tab is the deployment with no filesystem, so it looks like the one that most needs an upload. It needs the opposite. Under HMR the bundler has ALREADY replaced the module and `import.meta.hot` hands the page a new module OBJECT, so there are no bytes to send, nothing to instantiate from a URL, and no cache to defeat. The tab reconfigures itself with what its own dev server gave it.

That is worth recording rather than treating as a special case, because it says what the real primitive is. The seam is not "upload a processor"; it is "register this processor as a successor", and the three arrivals (read from disk, pushed as bytes, handed over by HMR) are thin adapters in front of one call. It also dissolves an authorisation question rather than answering it: there is no credential for the browser arrival because there is no remote caller. Pushing INTO a tab from outside would need one, and nothing needs that.

## Consequences

**The artifact must be pre-bundled.** A bare specifier cannot be resolved from a `data:` or `blob:` URL, so the caller's build produces one self-contained module. This is a real constraint on the caller and the honest place to state it is the endpoint's refusal.

**The module-instance leak is unchanged, not fixed.** Each pushed artifact adds a module to the registry for the life of the process, exactly as each cache-busted re-read does. Per build rather than per minute remains the guidance.

**The admin credential becomes explicit remote code execution authority.** It effectively already is, since it can move the canonical pointer and trigger a re-read of whatever is on disk, but accepting bytes makes it unmistakable and it should be written down rather than discovered by a reader.

**`version` stops being something an author must remember.** On this path the deployment computes it. `assertProcessorVersion` keeps its job for the filesystem path, where a declared version is still the only identity available.

**A size bound and a content type are part of the route**, since this is the first endpoint that accepts a payload whose size is not a function of chain data.

**The HMR arrival is built; the PUSHED-BYTES route is decided but deferred.** The shape above is accepted in full, and only one arrival is built now. The browser handover has an immediate consumer and needs none of the machinery (no route, no credential, no bytes, no size bound, no bundling refusal), while the upload route has no deployment today that cannot see its own build, and it is the half that carries every cost: explicit remote code execution on the admin credential, a payload bound, a content type, and a refusal for a bundle that is not self-contained. Build it when a deployment exists that the developer's build cannot write to. Recording it now is what keeps the seam shaped for three arrivals rather than two.

**The identity claim is sequenced separately from the mechanism.** That a pushed artifact's hash may serve as its version is available the moment bytes are received, but ADOPTING it as the identity trades a dependency on author discipline (failing as a false negative, silently ignoring a change) for one on build determinism (failing as a false positive, re-folding an identical commit). The false positive is the better failure only once it is cheap, which needs the bounded-count work in ADR-0084: before it, a spurious identity consumes a cap slot and a few of them stop the process starting. So the push may land first and the identity switch waits.

**It applies to the pushed arrival only.** A re-read from disk has only the declared version, and an HMR handover has a module object whose bytes were never seen, so this is a property of one arrival rather than a redefinition of identity everywhere.

## Amendment, 2026-09-22: the upload is un-deferred, and its target is The Graph's deploy UX

The consequence above deferred the pushed route until "a deployment exists that the developer's build cannot write to". That was the right trigger for a mechanism justified by reachability. The maintainer has since justified it by EXPERIENCE instead: re-reading from disk makes both development and deployment awkward, and the target is The Graph's shape, where a developer uploads a build to a running node and the node indexes it beside the live version before switching. Our model already does that second half: an upload registers a `successor`, and `on-catch-up` moves the pointer when it has caught up. So the route is un-deferred, and three things are decided with it:

- **The SENDER only uploads.** A command on the author's side takes an already-built bundle and pushes it; it does not run a build. Bundling stays the processor author's responsibility, as ADR-0086 already assumes, and a later command may take it on. That command cannot be called `build`, which already names the one-shot fold-to-completion command.
- **An upload CARRIES ITS OWN CONTRACTS, always,** through the existing route by which a processor module supplies its own contract data. It is needed even where the node already knows its source, so that the node can check the two MATCH and refuse an upload that does not, rather than folding a processor over contracts it was not written for.
- **A pushed processor survives a restart only because its bytes are stored** (ADR-0092). This reverses the push spec's launch claim that the route "does not need retention": for a node whose processors arrive by upload, the stored bytes are the only copy of the code it runs. So the upload is built after code retention.

The node that has nothing configured and waits for its first upload is ADR-0093.

## Decisions relocated from the upload spec when it was tasked, 2026-09-26

The spec `a-processor-artifact-is-pushed-to-a-running-deployment` made these decisions, and they are relocated here so they outlive its launch snapshot. All of them are built: the upload chain that tasked them landed its last task, `an-uploaded-processor-survives-a-restart`, on 2026-09-26. _This sentence was corrected in place when that task landed: it first said none of them was built yet, which was true when the spec was tasked and stopped being true with that task. The front-matter `status: accepted, not yet implemented` line came off in the same change._

- **An admin route on the existing credential**, beside the re-read and the pointer move, for ADR-0057's reasons. A surface that registers a new fold is at least as consequential as one that moves the pointer, and it is explicit remote-code-execution authority.
- **The identity is the receiver's hash of the received bytes**, never taken from the sender (ADR-0086).
- **A size bound and a content type are stated and enforced**, because an unbounded body on an authenticated route is still a way to exhaust a process.
- **Everything that can refuse happens before anything is registered**: self-containment, evaluation and the contract match. A refused upload leaves the deployment exactly as it was.
- **The contract match applies only to a source the OPERATOR configured.** Decided by the maintainer on 2026-09-26: a source changes legitimately, in development and in production (a new event a new handler needs, a contract upgraded with new events). So an upload is refused for carrying a different source only where the node was STARTED with an explicit one (`--deployments` or `INDEXING_SOURCE`), and "match" means the same resolved source (chain, contracts, events, start block). Where the node's source came from its processor module, or it was started with nothing (ADR-0093), an upload with different contracts is a successor on a new stream, as a re-read after a filter change already is. The disk path's precedence is unchanged.
- **The sender is `etherfold upload`**, named by the maintainer on 2026-09-26. It takes a bundle path, the target as `--to <url>` (never `--node-url`, which is the chain's RPC endpoint on every other command), a REQUIRED `--indexer` and the admin credential. It checks self-containment locally with the existing check, and never builds. `build` is taken and `deploy` is left for a later build-and-upload command.
- **The arrival is named in the outcome.** The three outcomes (`registered`, `unchanged`, `failed`) stay three, and which arrival produced one is a field beside them.
- **Three answers of 2026-09-26 that the tasks record where they belong.** A `successor` is also instantiated at open, so an upload that was still catching up survives a restart and is promoted as usual, while a `predecessor` still is not (an amendment to ADR-0092). A configured `--processor` that differs from the canonical generation's is an arrival like any other and registers as the new `successor` (an amendment to ADR-0093). And a START may not SILENTLY replace a different pending successor, however it arrived: an interactive start asks, a non-interactive one is refused unless `--override` is given, so a redeploy-per-commit pipeline passes it once in its configuration; the re-read and the upload, already deliberate acts, replace as before (amendments to ADR-0084 and ADR-0093).


## The upload route as built, 2026-09-26

`a-processor-bundle-is-uploaded-to-a-running-node` built the RECEIVING half of the decisions above: the route, the credential, the bound, the content type, the refusals before registering, the receiver's identity and the configured-source match. The sender (`etherfold upload`), a node that waits for its first upload (ADR-0093) and a pushed processor surviving a restart were their own tasks, and all three have landed since: `an-upload-command-sends-a-built-bundle`, `a-run-node-with-nothing-configured-waits-for-its-first-upload` and `an-uploaded-processor-survives-a-restart` (the last amends ADR-0084, ADR-0092 and ADR-0093). _That sentence was updated on 2026-09-26, when the last of them landed; it used to say they were still to be built._ The values the decisions above left open are these:

- **Where it lives:** `POST /{indexer}/admin/upload`, beside `reconfigure`, served by `etherfold run` (the combined shape) and by nothing else. A host that cannot turn bytes into a fold answers `501 upload-not-held`.
- **The body** is the bundle's raw octets, declared **`Content-Type: text/javascript`**, the one registered type for an ES module (RFC 9239). Only the media type is matched, case-insensitively; parameters such as `charset` are ignored, because the identity is the hash of the octets and nothing decodes them. Anything else answers `415 upload-wrong-content-type`.
- **The bound** is **16 MiB** (`MAX_UPLOAD_BYTES`, exported by `@etherfold/server`), inclusive. A declared `Content-Length` over it is refused before a byte is read, and an undeclared body is abandoned the moment it crosses it: `413 upload-too-large`. A constant rather than an input: generous for a minified processor carrying viem, small enough that one upload cannot exhaust the process, and no deployment has asked for another value.
- **The answers** are the shared three-outcome report with `arrival: 'upload'`, on the re-read's status codes so a sender maps outcome to status once: `200` for `registered` and `unchanged`, `409 upload-failed` for `failed` (not self-contained, throws on evaluation, carries no processor or no contracts, a mismatch with a configured source, a cap). The `401` is the admin guard's own. The `413` and `415` bodies also carry `arrival: 'upload'` and `outcome: 'failed'`.

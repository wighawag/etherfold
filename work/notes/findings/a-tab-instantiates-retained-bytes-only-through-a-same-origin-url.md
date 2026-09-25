---
title: 'A tab can instantiate retained bytes under a real CSP, but only through a SAME-ORIGIN URL: `blob:` and `data:` are refused by every realistic policy, and a service worker is the one mechanism that survives all of them'
slug: a-tab-instantiates-retained-bytes-only-through-a-same-origin-url
source: 'measured by docs/spikes/a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp (playwright 1.61.1 driving chromium 149.0.7827.55, firefox 151.0 and webkit 26.5 from nixpkgs'' playwright-driver.browsers), 16 runs per engine over 8 policies x 2 deliveries, against a server that really sets the header, on an AMD Ryzen 9 9955HX / Linux 6.18.49, 2026-09-17. The gateway policies quoted in section 4 were fetched live the same day. Raw rows in that folder''s results/.'
---

The open risk `a-generation-retains-the-code-that-folds-it` parked before being tasked: a generation retains the bundle that folds it so a `predecessor` can be RESUMED, and in a browser that means a tab has to turn stored bytes into a running processor. A strict Content-Security-Policy can forbid exactly that, and `script-src 'self'` alone is enough.

The answer is not a yes or a no, and the boundary is sharper than expected in both directions.

**Under every policy a real app ships, `blob:` and `data:` module imports are DEAD, and so is `new Function`.** `script-src 'self'` refuses all three, and so does the policy the reference deployment's own gateway actually sends.

**And yet a tab can still do it, through one mechanism: a service worker holding the retained bytes and answering a SAME-ORIGIN URL with them.** That worked under all eight policies, in all three engines, in the document AND inside a dedicated worker whose own response carried the strict policy. It is not a loophole: CSP matches on the URL a script is fetched from, so a script the app's own worker serves from the app's own origin is precisely what `'self'` means. What it costs is discussed in section 5, and it is not nothing.

All three engines agreed on **every row of the matrix**, and a policy delivered as a `<meta http-equiv>` bound identically to one delivered as a response header. That is worth saying because it is unusual: this repo's browser findings are normally a list of engine differences.

## 1. The matrix

Instantiation is counted as `ran` only when the bytes were loaded AND the processor FOLDED an event to the expected value. A missing error is not a result.

| policy | `import(blob:)` | `import(data:)` | `new Function` | `blob:` worker | service-worker URL |
| --- | --- | --- | --- | --- | --- |
| *(no CSP at all)* | ran | ran | ran | ran | ran |
| `default-src 'self'` | no | no | no | no | **ran** |
| `script-src 'self'` | no | no | no | no | **ran** |
| `script-src 'self' blob:` | ran | no | no | ran | ran |
| `script-src 'self' data:` | no | ran | no | no | ran |
| `script-src 'self' 'unsafe-eval'` | no | no | ran | no | ran |
| `script-src 'nonce-...' 'strict-dynamic'` | **ran** | **ran** | no | ran | ran |
| `default-src 'self'; img-src * data: blob: 'unsafe-inline'; style-src * 'unsafe-inline'` (gateway, section 4) | no | no | no | no | **ran** |

Three things in that table are worth reading twice.

**`blob:` and `data:` are not interchangeable and neither is a superset of the other.** They are separate source expressions: a policy allowing `blob:` refuses `data:` and vice versa. An app cannot list one and assume the other degrades.

**The strictest-LOOKING policy is the most permissive one here.** `script-src 'nonce-...' 'strict-dynamic'` is what the security literature recommends over an allowlist, and it ALLOWS both `blob:` and `data:` imports, because `'strict-dynamic'` propagates trust from the script doing the importing. It still refuses `new Function`, which needs `'unsafe-eval'` regardless. So the modern hardened policy is friendlier to retention than the naive `script-src 'self'`, which is the opposite of the intuition that stricter means less.

**`new Function` is the wrong thing to reach for anyway.** It needs `'unsafe-eval'`, the one directive a security review will always object to, and it cannot even accept the artifact: an ESM bundle's top-level `export` is a syntax error inside `Function`, so a deployment would have to retain a SECOND build in IIFE form purely to have something evaluable. That is two artifacts and two identities (ADR-0086 hashes bytes) for the least deployable mechanism in the table.

## 2. WHERE the fold runs decides the answer, and that is not the document

A browser indexer folds in a worker (ADR-0082), so the question is not really what the tab's document may do. A worker's policy comes from ITS OWN response, and the two contexts can differ:

| the page's policy | the worker script's own response | inside the worker |
| --- | --- | --- |
| `script-src 'self'` | no CSP (what a static host sends) | `blob:`, `data:`, `new Function` all ran |
| `script-src 'self'` | `script-src 'self'` | all refused; only the service-worker URL ran |

So a tab locked to `script-src 'self'` can still instantiate retained bytes inside a dedicated worker, IF the worker script is served without a policy of its own. That is not a trick to rely on blindly, because it depends on how the host serves a `.js` file, which an app does not always control (section 4 shows a gateway that puts the policy on every response, which closes this door).

A **`blob:` worker is different, and inherits**: it has no response of its own to carry a policy, so it takes the creating document's. Confirmed in all three engines by a probe rather than by reading the spec: under `script-src 'self' blob:`, the `blob:` worker was created and could import the bundle, and a `data:` import INSIDE that worker was refused with the page's policy.

## 3. What a blocked attempt looks like from inside the page

Every refusal was OBSERVABLE and none of them hung or tore the page down, but they do not arrive the same way: two come back as an exception the caller can catch at the call site, and the third arrives as an `error` event carrying no message at all.

| mechanism | how it arrives | chromium | firefox | webkit |
| --- | --- | --- | --- | --- |
| `import(blob:)` / `import(data:)` | rejected promise, `TypeError` | `Failed to fetch dynamically imported module: blob:...` | `error loading dynamically imported module: blob:...` | `Importing a module script failed.` |
| `new Function` | synchronous throw, `EvalError` | names the policy verbatim | `call to Function() blocked by CSP` | names the policy verbatim |
| `blob:` worker | `worker.onerror`, **message empty** | `(empty)` | `(empty)` | `(empty)` |

**And the error alone CANNOT tell a refusal from a corrupt artifact.** The control was the same bundle truncated mid-token, which is what a partially written retained artifact would be:

- with no CSP, or under a policy that ALLOWS the scheme, corrupt bytes reject with a `SyntaxError` (`Invalid or unexpected token` / `"" literal not terminated before end of script` / `Unexpected EOF`), and good bytes run. Distinguishable.
- under a policy that BLOCKS the scheme, corrupt bytes and good bytes produce the IDENTICAL `TypeError`, because the block happens before anything is parsed. Indistinguishable.

What does distinguish them is the `securitypolicyviolation` event, which fired for every refusal, in every engine, carrying `effectiveDirective` (`script-src-elem`, `script-src`, `worker-src`) and `blockedURI` (`blob`, `data`, `eval`) -- and fired for NO corrupt-bytes case. So an app that wants to say "your browser's security policy forbids resuming this generation" rather than "your retained bundle is damaged" has to listen for that event and correlate it with the attempt. The distinction is available, but only out-of-band: it is not on the error the promise rejects with, and WebKit's message does not even name the URL that was refused.

## 4. The reference deployment: the app does not know its own policy

`how-a-shipped-browser-indexer-is-actually-deployed.md` records the shape: the app is published to IPFS and reached through whichever gateway a user happens to use. So the policy is the GATEWAY's, it is not the app's choice, and it differs per gateway. Fetched live on 2026-09-17:

| host | `Content-Security-Policy` sent |
| --- | --- |
| `ipfs.io` (path gateway) | none |
| `<cid>.ipfs.dweb.link` (subdomain gateway) | none |
| `gateway.pinata.cloud` | `default-src 'self'; img-src * data: blob: 'unsafe-inline'; style-src * 'unsafe-inline'` |
| `stratagems.world` (the app's own domain, Vercel) | none |
| `snapshots.stratagems.world` (GitHub Pages) | none |

Pinata's is in the matrix above as the last row, verbatim, because it is the one policy in this spike that nobody chose for the sake of the experiment. Under it `blob:`, `data:` and `new Function` are all refused -- `img-src`'s `blob:` is irrelevant to scripts, and it is worth noticing how easily that header reads as permissive. Pinata also sends the header on EVERY response, including non-HTML ones (checked with `?format=raw`), so a worker script fetched through it carries the policy too and section 2's worker escape is closed there.

Two consequences for a browser build.

**The same build meets different policies at different users.** A user on `ipfs.io` can instantiate retained bytes any way at all; the same user on `gateway.pinata.cloud` can only do it through the service worker. So the mechanism cannot be chosen at build time. It has to be ATTEMPTED at runtime, with the outcome reported, which is also why section 3's distinguishability matters.

**An app can only tighten, never loosen.** The one instrument an IPFS-delivered app has over its own policy is a `<meta http-equiv>`, which this spike measured as binding exactly like the header. A `<meta>` cannot relax what a gateway header already imposed (policies intersect), so a deployment cannot opt back into `blob:` where a gateway has forbidden it.

## 5. What the retention spec should do about it

The browser half of `a-generation-retains-the-code-that-folds-it` is NOT invalidated: a tab really can resume a `predecessor` from retained bytes under a policy a real app ships. But it costs more than the spec assumes, and the shape of the cost should be decided before the work is tasked rather than discovered inside it.

**Do not build the retention path on `blob:` or `data:`.** They are the obvious mechanisms, they work in every dev setup (no dev server sends a CSP), and they fail on a gateway that sends one. A spike run under `vite dev` would have reported success for all three of them.

**A browser instantiation path therefore implies a SERVICE WORKER**, and that is a much bigger commitment than "read the bytes and import them": a registration, a scope, an update/versioning story, a cold start (registration and `clients.claim()` did control a first-visit page with no reload, measured here) and a fetch handler that reads the bytes out of IndexedDB. That is a component `@etherfold/browser` does not have today, and it is visible to the app: a library cannot silently register a service worker for an origin the app owns. So the honest way to spend this finding is to decide whether a browser revert is worth a service worker, and if it is, to task that explicitly rather than let it arrive as a detail of retention.

**Note the security fact that comes with it.** Serving retained bytes at a same-origin URL does not evade CSP so much as satisfy it: the app's own origin vouches for those bytes. That is exactly right for a bundle the app itself built and stored, and it would be a false assurance for bytes that arrived from somewhere else (ADR-0085's PUSHED artifact). If both paths ever meet in a browser, the provenance check has to be the app's, because CSP will no longer be making it.

**Whatever is built, the refusal must be a reported state rather than a stall**, which is story 8 of the spec and this finding gives it a concrete trigger: an instantiation attempt refused by policy, distinguished from damaged bytes by the `securitypolicyviolation` event, reported as "this generation cannot be resumed here" with the directive that refused it.

## 6. The alternatives, if the service worker is judged too expensive

Named and costed, not designed. Each is a real answer to "a tab holds a retained bundle it may not evaluate".

**Retain the module FACTORY in memory only.** The tab already has the processor object its own bundler loaded, so keep a reference to the outgoing generation's processor across a reconfigure and a revert can reuse it with no bytes evaluated at all. It costs nothing to build, needs no policy, and covers the common case exactly: reconfigure, watch the successor, revert because it was wrong -- all inside one page lifetime. What it does not survive is a RELOAD, which is also the moment the durable `predecessor` slot (ADR-0084) becomes the only record of what to go back to. So this gives a revert that works until the user refreshes, and nothing tells a tab that can still resume apart from one that cannot except whether it has been reloaded, which is close to the "two classes of generation differing invisibly" the spec rejected for bundling.

**Require the app to REGISTER every processor version it might revert to, at build time.** The app imports v1 and v2 and hands both to the indexer, so every generation it can hold has a live factory and nothing is evaluated at runtime. It is policy-proof, it needs no service worker, and it fits how a browser app is deployed anyway (the processor is bundled into the build, ADR-0086). The cost is that the revert target must be known when the build is made: a user running an old build cannot be given the ability to revert to a version that build never carried, and every retained version is dead weight in the bundle for every user who never reverts. It also reintroduces an author obligation of exactly the kind ADR-0086 deleted -- remembering to keep v1 in the build is remembering to bump `version` under another name.

**Accept that a browser revert is READ-ONLY, and say so.** The pointer moves back, the old state answers reads, and that generation does not advance until the app is rebuilt with the processor that folds it. This is what the deployment does TODAY, and the server had the same two-step until ADR-0092 made a Node revert resume folding from the generation's stored bundle (`packages/cli/test/aRevertResumesFolding.test.ts`). It costs nothing to build and it makes the revert promise smaller and true, which is the spec's own stated fallback ("withdrawn honestly"). The real cost is that the `predecessor` slot then means something different in a tab than on a server, and every later artifact has to keep saying which.

## 7. What was NOT measured

- **A real gateway serving a real app.** The gateway policies were fetched from the live hosts and reproduced VERBATIM by a local server; nothing was pinned to IPFS and loaded through a gateway end to end. The header is the same string, but a gateway could differ in ways a header does not capture (a service worker's scope on a path gateway, `Service-Worker-Allowed`, or a gateway that refuses to serve `sw.js` with a script content type).
- **Private browsing.** Firefox has historically disabled service workers in private windows; that was NOT verified here, and it matters, because if the retention path depends on one then a private-window user has no resume at all. Measure it before the design leans on the mechanism.
- **A service worker reading from IndexedDB.** The spike's worker holds the bytes in memory, deliberately: what was under test is whether a synthesised same-origin response is ADMITTED. A real one would read the retained artifact out of the store, and the cold-start ordering of that (worker starts, store opens, first import arrives) is a real question this does not answer.
- **`require-trusted-types-for 'script'`**, sandboxed iframes, and `Content-Security-Policy-Report-Only`. The first is the one most likely to move an answer in the table, since Trusted Types governs a different family of sinks than the ones measured here.
- **Real devices.** All three engines were headless on Linux. WebKit 26.5 is WPE rather than Safari on iOS, which is the deployment target most likely to differ.

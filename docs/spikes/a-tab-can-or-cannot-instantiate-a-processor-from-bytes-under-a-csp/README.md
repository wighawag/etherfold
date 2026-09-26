# Spike: can a tab instantiate a processor from BYTES under a realistic Content-Security-Policy?

Evidence for [`work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md`](https://github.com/wighawag/etherfold/blob/main/work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md), which is where the conclusions live. This folder holds the server, the page, the fixture bundle and the raw output, so every row of that finding's matrix can be re-run rather than believed.

Task: `work/tasks/done/a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp.md`. Spec whose open risk this answers: `a-generation-retains-the-code-that-folds-it` (a `predecessor` is RESUMED rather than merely read, which in a tab means evaluating retained bytes). Identity of those bytes is ADR-0086; where the fold runs in a browser is ADR-0082.

## The one thing this spike exists to get right

**The header is really set.** A bundler dev server sends no `Content-Security-Policy` at all, so a spike run under `vite dev` reports success and means nothing. `server.mjs` serves every page with a real policy chosen by the URL, and serves each worker script with its OWN (separately chosen) policy, because a worker's policy comes from its own response and not from the document that created it. That is measured here rather than assumed, and it turns out to be the difference between "a tab cannot do this" and "a tab can, in the place the fold actually runs".

## Layout

| file | what it is |
| --- | --- |
| `server.mjs` | the policies, and the routes that serve them. `POLICIES` is the matrix's first column |
| `page/mechanisms.js` | the mechanisms, written once and run in BOTH the document and a worker |
| `page/harness.js` | the document-side runner: portable mechanisms, then the service worker, then two workers |
| `page/worker.js` | the worker-side runner, under whatever policy its own response carried |
| `page/sw.js` | a service worker that holds retained bytes and answers a SAME-ORIGIN URL with them |
| `fixture/processor.entry.js` + `counter.js` | the narrowest real processor: a fold that can be RUN, plus a sibling module so the artifact is genuinely a bundle |
| `fixture/processor.bundle.js` | that entry built with the documented command (`esbuild --bundle --format=esm --minify`), 153 bytes |
| `fixture/processor.iife.js` | the same, as an IIFE, because an ESM bundle cannot be passed to `new Function` at all |
| `build-bundle.mjs` | rebuilds both (needs esbuild's postinstall; the built fixtures are committed, so this is only for regenerating them) |
| `run.mjs` | the driver: one browser context per (engine, delivery, policy) |
| `summarise.mjs` | renders `results/` as the matrices the finding quotes, so the tables are derived rather than transcribed |
| `results/csp-*.json` | raw rows, one file per engine |

The CORRUPT artifact has no file: `/artifact/corrupt` is the real bundle cut off at 40 bytes, which is what a partially written retained artifact would be, and it is the control for the only question an app has at runtime -- was I refused, or are my bytes damaged?

## Running it

```sh
npm install
node run.mjs                 # every engine
node run.mjs chromium        # or just one
node summarise.mjs           # the matrices
node server.mjs 8099         # or drive it by hand, one policy per URL
```

Serving it by hand prints both deliveries of every policy: `/p/<policy>/` puts it in the response HEADER, `/m/<policy>/` puts it in a `<meta http-equiv>`, which is the only instrument an app delivered by an IPFS gateway has over its own policy.

**On NixOS**, playwright's downloaded Firefox and WebKit will not launch against the host's libraries, and WebKit additionally needs a working EGL. What worked on 2026-09-17 was nixpkgs' own browser bundle (which is why `playwright` is pinned to **1.61.1** here: the npm package and `nixpkgs#playwright-driver` must agree on browser revisions):

```sh
nix shell nixpkgs#mesa nixpkgs#libglvnd --command bash
export PLAYWRIGHT_BROWSERS_PATH=$(nix build --no-link --print-out-paths nixpkgs#playwright-driver.browsers)
export EGL_PLATFORM=surfaceless LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe MESA_LOADER_DRIVER_OVERRIDE=llvmpipe
node run.mjs
```

**WebKit may not relaunch on a re-run.** Re-running this on 2026-09-17 to verify the committed results, Chromium and Firefox reproduced exactly (110 verdicts per engine, none differing from `results/csp-*.json`), and WebKit then threw `browserContext.newPage: Target page, context or browser has been closed` on its first page, under the same recipe that had produced `results/csp-webkit.json` minutes earlier. Not investigated: it is a harness signal, not a result one. Expect to fight the WebKit launch when re-verifying, and do not read a red WebKit run as a changed answer.

## Two instrument notes, because both changed a result

**The driver must pass a FUNCTION to `waitForFunction`, never a string.** A string is delivered to the page as `Runtime.evaluate`, which is exactly what `script-src 'self'` forbids, so the first complete run reported "the harness never finished" for six of the eight policies. That is the driver being refused, not the mechanism. `browser-storage-headroom-for-generations.md` records the same lesson from the other side: clear the instrument before believing a row.

**The harness has no imports of its own.** `mechanisms.js` is CONCATENATED by the server in front of each entry rather than imported by it, because under a policy strict enough to block the harness's own module graph an imported helper turns a measurement into a timeout.

## What is deliberately NOT here

No retention path, no change to `@etherfold/browser`, no new dependency in any shipped package (`playwright` and `esbuild` are this folder's own devDependencies, in the manner of every other spike here). The bytes are held in the service worker's memory rather than in IndexedDB on purpose: what is being measured is whether a synthesised same-origin response is ADMITTED, and the store it came from changes nothing about the policy question.

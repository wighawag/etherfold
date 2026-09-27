# A tab runs a published processor bundle: the real-engine check

`loadProcessorBundle` (`packages/browser/src/processorBundle.ts`) fetches a published bundle, names it by the SHA-256 of the fetched octets and instantiates it from those bytes through a `data:` URL, falling back to a `blob:` one. The vitest suite (`packages/browser/test/aTabRunsAPublishedProcessorBundle.test.ts`) runs in Node, which has no Content-Security-Policy, so it drives `forbidden-by-policy` through the injectable importer. This harness is the other half: the same code in real engines, under a real policy header.

Run from the repository root after `pnpm install`: `node docs/spikes/a-tab-runs-a-published-processor-bundle/measure.mjs chromium,firefox,webkit`. The page, the page's script and the bundle are all served with the same `Content-Security-Policy` header, so a dedicated module worker started from the page carries the policy on its own response too.

## Result, 2026-09-27 (playwright 1.62.1, headless, Linux)

| policy | chromium main | chromium worker | webkit main | webkit worker |
| --- | --- | --- | --- | --- |
| none | instantiated | instantiated | instantiated | instantiated |
| `script-src 'self'` | forbidden-by-policy, both violations named | forbidden-by-policy, both violations named | forbidden-by-policy, both violations named | forbidden-by-policy, NO violation event observed |
| `script-src 'self' blob:` | instantiated (via `blob:`) | instantiated | instantiated | instantiated |
| `script-src 'self' data:` | instantiated (via `data:`) | instantiated | instantiated | instantiated |

Every instantiated row reported the same identity, `sha256:` over the fetched bytes. Firefox did not launch in this environment, so it was not measured here; the finding `work/notes/findings/a-tab-instantiates-retained-bytes-only-through-a-same-origin-url.md` records all three engines agreeing on every row of the same matrix.

Two things worth knowing:

- The PROBE is what makes the refusal honest. Under a blocking policy a good bundle and a corrupt one reject with the identical error, so the loader first imports a trivial module through each scheme and only imports the real bytes through one that passed; a failure after that is the bytes' own (`unreadable-module`).
- WebKit inside a worker did not deliver a `securitypolicyviolation` event within the macrotask the loader waits, so its refusal still says `forbidden-by-policy` and names the Content-Security-Policy, but cannot quote the policy text. Chromium delivers it in both contexts.

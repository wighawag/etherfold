# a-sharedworker-serves-several-tabs-from-one-host: the two-tab evidence

What the SHAREDWORKER hosting shape did in real browsers, with real tabs, kept so that ADR-0082's second shape points at an OBSERVATION rather than at a claim.

Nothing here was measured; every file is the structured output of a case, per engine. The claims are behavioural: two documents reach ONE host with nothing configured to make them, one fold runs, a tab closing does not take the host down, and the tab after the last one RESUMES.

## How it is produced

```bash
pnpm --filter @etherfold/browser test:browser sharedWorkerServesSeveralTabs              # all three engines
pnpm --filter @etherfold/browser test:browser --project=webkit sharedWorkerServesSeveralTabs
```

The spec is `packages/browser/browser/sharedWorkerServesSeveralTabs.spec.ts`, on `playwright-browser-harness`: one lead harness builds and serves the bundle, and every other tab mounts against the same `outdir` and `serverUrl`, which is what makes them tabs of one app on one origin rather than two apps. It is deliberately NOT part of `pnpm test` (the acceptance gate), because it needs `playwright install` and three browser binaries a clean checkout does not have. The node suite asserts the same claims over real `MessagePort`s on every commit (`packages/browser/test/aSharedWorkerServesSeveralTabs.test.ts`), with the `connect` event faked, because that is the only part a node process cannot have.

## What is in `results/`

| file | what it holds |
| --- | --- |
| `two-tabs-<engine>.json` | two tabs attaching at once: what each was answered, what it was PUSHED, and the ranges the one fold asked the node for. Plus the second host a different NAME produced on the same script URL |
| `lifecycle-<engine>.json` | the same two tabs with the fold HELD at block 103, one tab closed, the fold carried to the tip by the tab that stayed, and then a third tab after the last one went away |
| `both-shapes-<engine>.json` | ONE built entry file loaded as a `Worker` and as a `SharedWorker`, with one piece of app code run against each port |

## What the three engines agreed on

Chromium, Firefox and WebKit, identically:

- **one host per script URL plus name.** Both tabs report the same `instance` (a value the fixture entry mints once per script execution and says straight at every attached page, off the port). A second NAME on the same URL is a different `instance`, and a different query string is too, which is the scoping the ADR notes and the reason two apps on one origin never collide.
- **one fold.** The ranges asked of the fixture chain are `100-103` then `102-105`, once each, reported to both tabs. A host per tab would have asked for the span twice.
- **both tabs read the same state and both are pushed progress**, phases `waiting -> loading -> catching-up -> at-tip`, from a `SharedWorkerGlobalScope` while the page is a `Window`.
- **a tab closing is not the host closing.** After a real `page.close()` the remaining tab carries the fold from 103 to the tip against the SAME `instance`.
- **the browser ends the worker when its LAST client goes.** The third tab always reports a NEW `instance`, which is what makes the next line a resume rather than a reconnect.
- **it resumes.** The fresh host asks only for `102-105` (the unconfirmed window) and never for the start block, and lands on the same rows: `{owners: {1: BOB, 2: ERIN, 3: DAN}, transfers: 5}`, the constant every other case in this package asserts.
- **the two shapes are indistinguishable to app code.** Everything `whatAnAppSees` reports matches between the shapes except `host` and `scope`, the two fields that SAY which shape answered.

One thing worth writing down because it decided the fixture: all three engines support MODULE shared workers (`new SharedWorker(url, {type: 'module'})`), and none of them accepts the esbuild ESM bundle as a CLASSIC script. So a runtime that has `SharedWorker` but not module support would construct happily and never run, which is why `sharedWorkerHost` logs what happened when the worker raises `error` and leaves the port to conclude a death from the silence.

<!-- dorfl-sidecar: item=task:a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp type=task slug=a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp allAnswered=false -->

## Q1

**'task:a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp' was bounced — how should we proceed?**

> NOT task drift, and NOT a defect in the task: the task is well-scoped and the spike ANSWERED it. This is an INFRASTRUCTURE failure. The claimed worktree at /home/wighawag/.dorfl/work/github-com__wighawag__etherfold__a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp was deleted by something outside the agent session while the task was in progress (that path and all of ~/.dorfl/work/ are now empty). The uncommitted spike sources and the results JSON went with it, and because the bash tool resolves its cwd to that deleted path, no further shell command could be run: no re-write into a tree, no re-run, no gate. There is therefore NO source change to review, and the gate would have nothing to check.
>
> The WORK IS NOT LOST. The measurement completed before the deletion, and the full deliverable set is reconstructed at /tmp/etherfold-csp-spike-rescue/ :
>   - work/notes/findings/a-tab-instantiates-a-processor-from-bytes-only-where-the-host-permits-it.md  (the deliverable: mechanism-by-policy matrix, what a blocked attempt looks like from inside the page, the reference deployment's real gateway headers, the three named-and-costed alternatives, and what the retention spec should do)
>   - work/notes/observations/playwright-firefox-and-webkit-cannot-launch-on-this-host.md
>   - docs/spikes/a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp/  (server, page, probe, worker host, spec, config, README, results/)
>   - README.txt  (the four steps to finish)
>
> SUGGESTED ACTION: re-run this item, do not re-scope it. Give an agent a fresh worktree, copy the two trees above in, then `cd docs/spikes/a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp && npm install && npx playwright test --project=chromium` (about 9s, 10 cases) to regenerate results/csp-chromium.json, and delete results/csp-chromium-captured-run.md once the real JSON is back. The spike sits outside the pnpm workspace globs and under docs/, which .prettierignore excludes, so the root gate is unaffected and no changeset is needed. Two things in the rescued finding are honestly flagged and should stay flagged unless re-measured: it is CHROMIUM-ONLY (firefox and webkit cannot launch on this host), and the `new-Function` rows come from a run whose eval mechanism was handed ESM bytes, which distinguishes permitted from forbidden cleanly but never ran a fold through eval (the committed source fixes it; the fix was not re-measured).
>
> ALSO WORTH A HUMAN'S ATTENTION INDEPENDENTLY: whatever removed the active worktree mid-task. If that can happen to this item it can happen to any of them, and a builder cannot detect it before it has already destroyed the uncommitted work.

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

## Q2

**'task:a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm check:adr && pnpm check:refs && pnpm check:changesets && { [ "$GITHUB_HEAD_REF" = "changeset-release/main" ] && echo 'skip changeset status on the Version PR (it consumes changesets)' || pnpm changeset status --since=main; } && pnpm build && pnpm typecheck && pnpm test`; its last output was:
>
> [WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides". See https://pnpm.io/settings for the new home of each setting.
> > etherfold-monorepo@ format:check /tmp/dorfl-fresh-gate-ennYsZ/tip
> > prettier --check .
> Checking formatting...
> All matched files use Prettier code style!
> [WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides". See https://pnpm.io/settings for the new home of each setting.
> > etherfold-monorepo@ check:adr /tmp/dorfl-fresh-gate-ennYsZ/tip
> > node scripts/check-adr-numbers.mjs
> docs/adr: 86 ADRs, no duplicate numbers (self-check: 4 cases, 2 rejecting)
> [WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides". See https://pnpm.io/settings for the new home of each setting.
> > etherfold-monorepo@ check:refs /tmp/dorfl-fresh-gate-ennYsZ/tip
> > node scripts/check-work-refs.mjs
> 1 dead work/ reference(s):
>   docs/spikes/a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp/README.md
>     -> work/tasks/ready/a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp.md
>        MOVED to work/tasks/done/a-tab-can-or-cannot-instantiate-a-processor-from-bytes-under-a-csp.md -- update the citation
> A status-folder move is normal, so a citation of a work/ artifact has to be updated with it. If the reference is HISTORICAL rather than navigational, the surface holding it probably belongs in this check's exempt list (see the header) rather than being reworded.
>  ELIFECYCLE  Command failed with exit code 1.

<!-- q2 fields: id=q2 kind=stuck -->

**Your answer** (write below this line):

<!-- dorfl-sidecar: item=task:the-cli-schedules-the-prune-its-retention-implies type=task slug=the-cli-schedules-the-prune-its-retention-implies allAnswered=false -->

## Q1

**'task:the-cli-schedules-the-prune-its-retention-implies' was bounced — how should we proceed?**

> acceptance gate failed (exit 1) on the rebased tip — the failing step was: `pnpm format:check && pnpm check:adr && pnpm check:refs && { [ "$GITHUB_HEAD_REF" = "changeset-release/main" ] && echo 'skip changeset status on the Version PR (it consumes changesets)' || pnpm changeset status --since=main; } && pnpm build && pnpm typecheck && pnpm test`; its last output was:
>
> > etherfold-monorepo@ format:check /tmp/dorfl-fresh-gate-UHN12N/tip
> > prettier --check .
> Checking formatting...
> All matched files use Prettier code style!
> > etherfold-monorepo@ check:adr /tmp/dorfl-fresh-gate-UHN12N/tip
> > node scripts/check-adr-numbers.mjs
> docs/adr: 74 ADRs, no duplicate numbers (self-check: 4 cases, 2 rejecting)
> > etherfold-monorepo@ check:refs /tmp/dorfl-fresh-gate-UHN12N/tip
> > node scripts/check-work-refs.mjs
> work/ references: all resolve (838 files scanned, 201 artifacts indexed)
> 🦋  error Error: Found mixed changeset the-cli-schedules-the-prune-its-retention-implies
> 🦋  error Found ignored packages: @etherfold/platform-cf-worker
> 🦋  error Found not ignored packages: @etherfold/state-store etherfold
> 🦋  error Mixed changesets that contain both ignored and not ignored packages are not allowed
> 🦋  error     at getRelevantChangesets (/tmp/dorfl-fresh-gate-UHN12N/tip/node_modules/.pnpm/@changesets+assemble-release-plan@6.0.10/node_modules/@changesets/assemble-release-plan/dist/changesets-assemble-release-plan.cjs.js:600:13)
> 🦋  error     at Object.assembleReleasePlan [as default] (/tmp/dorfl-fresh-gate-UHN12N/tip/node_modules/.pnpm/@changesets+assemble-release-plan@6.0.10/node_modules/@changesets/assemble-release-plan/dist/changesets-assemble-release-plan.cjs.js:513:30)
> 🦋  error     at Object.getReleasePlan [as default] (/tmp/dorfl-fresh-gate-UHN12N/tip/node_modules/.pnpm/@changesets+get-release-plan@4.0.16/node_modules/@changesets/get-release-plan/dist/changesets-get-release-plan.cjs.js:69:49)
> 🦋  error     at async status (/tmp/dorfl-fresh-gate-UHN12N/tip/node_modules/.pnpm/@changesets+cli@2.31.0_@types+node@25.9.1/node_modules/@changesets/cli/dist/changesets-cli.cjs.js:1239:23)
> 🦋  error     at async run (/tmp/dorfl-fresh-gate-UHN12N/tip/node_modules/.pnpm/@changesets+cli@2.31.0_@types+node@25.9.1/node_modules/@changesets/cli/dist/changesets-cli.cjs.js:1597:11)

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

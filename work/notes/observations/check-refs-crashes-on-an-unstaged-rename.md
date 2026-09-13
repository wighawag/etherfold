---
title: '`pnpm check:refs` crashes on a file the working tree renamed but the index has not'
slug: check-refs-crashes-on-an-unstaged-rename
observed: 2026-09-13
---

2026-09-13 — `scripts/check-work-refs.mjs` enumerates `git ls-files` (the INDEX) and then `readFile`s each path, so a tracked file that the working tree has RENAMED or DELETED but not staged makes it die with an unhandled `ENOENT` naming the old path, rather than reporting a dead reference. Hit while renaming two test files during `a-retraction-names-the-fork-point-it-withdrew`; the renames were reverted rather than staged, since the agent does no git and the gate runs `check:refs` before the runner's `git add -A`. A one-line `existsSync(file)` skip in the scan loop would make the check read the working tree it is actually checking.

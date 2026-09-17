<!-- dorfl-sidecar: item=task:a-processor-artifact-is-bytes-a-hash-and-a-loader type=task slug=a-processor-artifact-is-bytes-a-hash-and-a-loader allAnswered=false -->

## Q1

**'task:a-processor-artifact-is-bytes-a-hash-and-a-loader' was bounced — how should we proceed?**

> NOT a defect in the task: the task body and its spec are sound, un-drifted and buildable as written. This is an orchestration fault that destroyed the run.
>
> A SECOND `dorfl do task:a-processor-artifact-is-bytes-a-hash-and-a-loader --isolated` was dispatched at 16:34 (from /tmp/drive-etherfold/dispatch.sh, unit dorfl-do-a-processor-artifact-is-bytes-a-hash-and-a-loader.service) while this run, claimed at 16:20, was still building. Because dorfl derives the worktree path from the item slug, the second run DELETED and recreated /home/wighawag/.dorfl/work/github-com__wighawag__etherfold__a-processor-artifact-is-bytes-a-hash-and-a-loader out from under this agent, and its log shows it re-CLAIMED the item ("lock held"). Both runs were alive simultaneously (PIDs 2296617/2296642 at 16:20, 2320401/2320426 at 16:34). All work from this run was lost with the tree; nothing of it remains (the recreated tree is clean).
>
> This run made NO source change and did not rebuild, because the recreated worktree is owned by the newer run that now holds the lock: two agents editing one worktree would interleave edits that either runner's `git add -A` would sweep, and any result from this run would land under a lock it no longer holds.
>
> Suggested re-scope: (1) make dispatch.sh refuse to start when the unit for that slug is already active or the item's claim is already held, since dorfl reuses one worktree path per slug and a duplicate dispatch is destructive rather than merely wasteful; (2) confirm which of the two live runs owns the item, kill the other; (3) re-run the item once, unchanged. No change to the task, the spec or the ADRs is needed.
>
> Design notes from the lost build, so the re-run does not re-derive them, are in the report above: home is packages/utils/src/processorArtifact.ts; three functions (processorArtifactHash / validateProcessorArtifact / instantiateProcessorArtifact) with seed-path-style DATA refusals; instantiation by importing a data: URL and reusing instantiateProcessor for module-shape refusals; a node builtin (prefixed or bare) is self-contained and a relative specifier is not, verified empirically against Node 24; the self-containment check needs a linear string/comment/regex/template-aware scan rather than a regex; fixtures built once with esbuild --bundle --format=esm --minify; and two gate traps (minified fixtures must go in .prettierignore, and no work/tasks/ready/ citation in source or check:refs fails on the done-move).

<!-- q1 fields: id=q1 kind=stuck -->

**Your answer** (write below this line):

# A task handed to a builder as claimed in ready/ was still in backlog/

Observed 2026-09-28 while building `a-graphql-schema-is-built-from-the-declarations`: the runner's prompt said the task was claimed and lived at `work/tasks/ready/a-graphql-schema-is-built-from-the-declarations.md`, but the checkout had no `work/tasks/ready/` folder at all and the body was at `work/tasks/backlog/a-graphql-schema-is-built-from-the-declarations.md`. Its three blockers were in `done/`, so the build went ahead; the done-move may need to start from `backlog/`.

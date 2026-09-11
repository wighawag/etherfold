---
'@etherfold/server': patch
---

**The server's `SCHEMA_VERSION` restarts at 1**, and the `_meta` row in `db.sql` with it.

The constant had reached 4, with three paragraphs narrating what each step added (the reserved `_` namespace, the generation registry, the stream coverage claim) and what an existing database of each earlier version would gain. Nothing is published, so no database anywhere was created by an earlier build: those were migration notes for a population of zero, and a reader had to get to the end of them to find that out.

The version row, the `_meta` table and the `/status` comparison are all KEPT unchanged, because what they do is entirely forward-looking and does not need a history behind it: the two paths that bring a database to this shape are not both ours (`applySchema` runs `db.sql`, and wrangler's D1 migrations execute that file and nothing else), so a deployed server can meet a database another build's SQL created, and a disagreement has to surface at `/status` rather than as a random query failure later. That is also why the row lives in the SQL rather than being written by the code that applies it.

What replaces the ladder is the rule stated forwards: bump it when `db.sql` changes in a way an existing database has to be told about, keep the row in step (a test asserts they agree), and note the one case that is stronger than a bump -- a change that renames or removes `_meta` itself leaves an older database with no row to read, which reports `applied: false`.

**If you are running a server against a database an earlier build of this unpublished package created**, `/status` will now report a version mismatch and answer `503`. That is the mechanism working. Re-apply the schema (`POST /admin/setup`), which upserts the row.

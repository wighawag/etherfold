---
'@etherfold/triggers': patch
---

An idle trigger round writes nothing but the lease renewal (ADR-0101). A consumer step whose page carried no entry and left the stream and generation unchanged (and does not say it has more) no longer rewrites the app's `consumers` row: the cursor the canonical view hands back on an empty page differs only by its high-water `since` mark, not by its position, so the older cursor is kept and the next committed step (a page carrying entries, a rewind, a pause) writes the newest one. A rewind and a stream change are still written on an otherwise empty page. At the 5 s default interval this removes about 518k writes a month per idle app.

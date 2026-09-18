# ADR-0084 may still carry an expired `accepted, not yet implemented` line

2026-09-18, noticed while removing ADR-0086's expiring status line (`the-build-command-and-its-pinning-rule-are-documented`).

`docs/adr/0084-a-generation-is-held-by-named-durable-slots-and-canonical-is-merely-the-first-one.md` still declares `status: accepted, not yet implemented`, while `work/tasks/done/` holds `a-successor-lands-in-a-durable-slot-that-holds-one.md` and `a-generation-no-slot-names-is-reclaimed-on-request.md`, which read like its family. Not verified against the code, and out of scope here. (ADR-0085 carries the same line and looks CORRECT: its spec `a-processor-artifact-is-pushed-to-a-running-deployment` is still in `work/specs/ready/`.)

---
title: A promotion at a quiet tip posts no state-moved notification, so a tab reading through the port keeps showing the retired generation's answer
slug: a-promotion-at-a-quiet-tip-posts-no-state-moved
---

2026-09-27. Measured while building `a-worker-host-takes-a-hot-updated-processor`: a worker host at the tip took a successor, the successor caught up and was promoted, and the port's `onStateMoved` posted NOTHING (3 notifications before, 3 after) while `reads.getCurrent` already answered the new generation's value. That is by design in core (`packages/core/src/stateMoved.ts`, `rotate`: "the promotion PUBLISHES nothing ... the next notification carries the new token"), but on a chain with no new block there is no next notification, so a tab that re-reads on `onStateMoved` (as `examples/browser-reference/browser/main.ts` taught, and as its comment claimed a promotion triggers) never re-renders. The reference now works around it by asking `generations()` on each progress push while a switch is pending; axis two had the same latent gap, hidden because its test's count is the same before and after. Whether a pointer move should publish a notification of its own is open.

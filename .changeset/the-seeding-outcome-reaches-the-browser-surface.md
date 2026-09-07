---
'@etherfold/browser': minor
---

**The stream-seeding outcome now reaches the surface an application already subscribes to.** An app can render "installing", "seeded at block N", or a refusal with a reason it can explain, instead of the unexplained empty screen ADR-0064 names as the outcome the whole seeding spec exists to avoid.

It lands on the EXISTING stores and adds no reactive mechanism:

- **`SyncingState.streamSeed`**, a new field beside `error` and `nonCanonicalGenerations`, carrying a small discriminated state: `{status: 'installing'}`, `{status: 'seeded', at, reachesBackTo, from, events, segments}`, `{status: 'refused', reason, direction?}`, or ABSENT where no seed was asked for. Additive, so no existing subscriber changes and no existing field changes meaning.
- **`StatusState.state` gains `'InstallingStreamSeed'`**, beside `Loading`, `FetchingEventStream` and the rest, because that enum is where applications already switch to choose what to render. The phase LEAVES that value at the terminal outcome (back to `Idle` until the load moves it on): a phase says what is happening, and what happened is the field above.

**`error` is deliberately NOT reused.** A refusal is a NORMAL condition -- the app still starts and still indexes forward (ADR-0064) -- so an app treating `error` as a fault would render a crash for an ordinary outcome, and `acknowledgeError()` does not fit an outcome nothing can acknowledge away.

**`createIndexerState` takes an optional `seed`** (`BrowserStreamSeedOptions`: the ordered `locations`, an optional `expectedContentHash`, `reachBackTo`, `maxEventsPerBatch` and an injectable `fetch`) and runs `installStreamSeed` at `init`, BEFORE the generation is built, publishing `installing` and then the terminal outcome. It needs a `keepStream` and RAISES without one, because a seed IS a stream and no location makes a missing keeper right. The trust contract is unchanged and is the caller's: keep both the locations and any pin in the BUILD (ADR-0066).

**The hook option is ERGONOMICS, not a safety mechanism.** Driving `installStreamSeed` (`@etherfold/core`) directly still works, and is asserted correct BOTH before `init()` and after it, because the install carries its own resolved stream config and sets it on the keeper before addressing anything (ADR-0067). An app that starts indexing before installing gets the `subtree-not-empty` refusal, which is loud, as data, and leaves the stream it refused intact.

**The direction is DATA and nothing infers from it.** `direction` is the refusal reason narrowed to `seed-covers-more` / `seed-covers-less`, present only where the reason names one, so an app can switch on one field. An application may render "a newer version of this app may be available"; this library may not, because a deliberately narrower client is indistinguishable from a stale one.

**No byte-level progress**, and that is measured rather than assumed: the whole install is about 1 s on a mid-range phone in the shape this ships, which a spinner covers, and the variable part is the DOWNLOAD. `installing` plus one terminal state is the whole surface, so the field publishes at most twice per boot.

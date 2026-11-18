---
status: accepted; built by the trigger service packages, outside the indexer-server (ADR-0100)
---

# Trigger conditions are data; predicates and actions are code

A trigger is **declarative data referencing operator-deployed code**. The **matcher** is a filter over a log's **decoded arguments**, stored so that matching many subscribers against one log is an indexed lookup. The **state predicate** is a *named* implementation, deployed by the operator and parameterised by the registration. A user registers data (a filter, a predicate name, arguments); a user never supplies code, and there is no bespoke DSL.

## Why this split

Matching must be data because of the scaling shape. "Notify me of arrivals at these systems" is one user with a set of values, times many users; given an arrival at system D, the service must find every subscriber whose set contains D. As data that is an inverted index, `(eventName, argName, value) → trigger`, and one indexed lookup per log. As code hooks it is running N user functions per log, which does not survive a real user base.

Predicates must be code because the expressive part (a threshold, a spatial approximation, a comparison against as-of-block state) is where a data language would drift into being a query language, badly. Naming operator-supplied implementations and letting registrations parameterise them keeps runtime registration safe for untrusted users while leaving expressiveness in a language that already exists.

## Consequences

- **The matcher is defined over DECODED arguments, not topics.** Topics only carry *indexed* event parameters, and the field a trigger cares about (an arrival's destination system) may well not be indexed, since the ABIs were not designed around this. Topic columns are a fast path when the argument happens to be indexed, never the model.
- **Two archetypes, two registration surfaces.** *Subscription triggers* are user-registered values whose recipient is the registrant (an arrival notification). *Global rule triggers* are one operator-defined rule over all events whose recipient is **computed** from the event or state (a badge award). They share the matcher and differ in who may register and how the recipient is resolved.
- **Evaluation is level-triggered, and that is sufficient.** A threshold trigger ("owns at least X systems") is evaluated on every relevant event rather than by detecting the crossing, which would need state at two blocks. Repeat firings are absorbed by the semantic idempotency key (ADR-0009), which also gives the right behaviour when a player drops below the threshold and returns: the badge is already earned. See also ADR-0011 on keeping such aggregates as state fields so the predicate is a point read.
- **Consumers pull the feed unfiltered by default.** A filtered pull (sending the union of a consumer's trigger filters) does not violate ADR-0005, since the filter lives in the request rather than in server state, but it is dangerous: advancing a cursor under filter `F1` and later widening to `F2` silently loses every event matching `F2` minus `F1` between the two positions. If filtered pull is ever offered, the filter must be **pinned to the cursor**, so changing it is an explicit re-read from the change point rather than an invisible gap.
- **User-supplied code is never executed**, which is what makes runtime registration by untrusted users acceptable at all.
- A single-tenant deployment whose operator defines every trigger can skip registration entirely and write plain code hooks. The data layer exists for the multi-subscriber case, not as ceremony.

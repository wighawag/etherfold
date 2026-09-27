---
'@etherfold/browser': minor
---

A worker host takes its provider and its settings from the tab that connects (ADR-0082, amended).

`connectToIndexerHost(access, {provider, settings, onConnect})` hands the host what only the tab knows. `provider` crosses as a `MessagePort` speaking `@eip-1193/over-port` (now a dependency): a provider object (a wallet's) is served by the port on a fresh `MessageChannel`, a `MessagePort` already served elsewhere (a node in another worker, such as `webevm`) is transferred as is so requests go worker to worker, and a function returning such a port is called once per host so a restart can be handed one again. `settings` (`HostSettings`: `source`, `config`, `publication`, `catchUpWithinSeconds`, `seed`, `promotion`) is checked for cloneability on the tab, naming the field. Both are sent first on every host the port obtains, as a new `connect` case on the envelope; `MessageEndpoint.postMessage` takes an optional transfer list for it.

`HostedIndexerSpec.provider` and `.source` are now optional: a worker entry that leaves either out waits (`phase: 'waiting'`) until a tab hands them over, and one that holds both starts at once, as before. A value given by the entry and by a tab must agree, and a host that has started keeps the settings it started with, so a disagreement (including a provider sent to a host whose entry built one, or a setting the host started without) is refused as `HostSettingsConflictError` naming its `fields`, and nothing of that connect is applied. The tab learns the outcome through `onConnect` (once per host), and a refusal is logged either way. A main-thread host refuses `connect`: it takes its provider and settings from `init`.

A SharedWorker host pools the providers its tabs hand over, folds through the first attached tab's, and moves to another tab's when that tab goes away (its port throws on a post, or fires `close` where the engine fires one), retrying what was in flight. With no tab left it fails with the retryable `NoTabProviderError`, which the driver retries as it retries a provider that is down.

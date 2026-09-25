---
'@etherfold/core': minor
'etherfold': minor
---

**An upgrading restart keeps the incumbent FOLDING while the successor catches up** (ADR-0092). A Node deployment restarted with a changed processor used to hold a fold for the new processor only, so the canonical generation answered every read frozen for the whole catch-up. Now the canonical generation is instantiated from the bundle stored on its registry row at `open`, and it goes on advancing until the pointer leaves it.

`@etherfold/core`:

- `ReceivingIndexer.open` instantiates the CANONICAL generation, and only it, through the host's `instantiateGeneration` when this process holds no fold for it. This is the same seam a revert uses. It runs after the configured fold is added, so under `immediate` (or a successor that already caught up) nothing is instantiated for a generation that no longer answers reads. No `predecessor` or other stored generation is instantiated at open.
- A canonical generation whose stored code cannot be built at open is logged as an error and answers reads frozen. The deployment still starts, and the upgrade can still complete. A canonical generation on a stream this deployment does not fetch is logged and left frozen.
- A fold this process instantiated from stored bytes is held only while the pointer names it. A PROMOTION away from it now stops folding it, as a revert already did. It stays registered as `predecessor`, with its state and bundle. A fold the host was handed keeps the retention it had.
- The promotion trigger now compares against an incumbent that moves. Where this process folds the incumbent, the cursor comparison and the pointer move run on that fold's advance chain. Nothing folds into the incumbent between its cursor being read and the pointer leaving it, so the successor is promoted only at or past where the incumbent finally stood.

`etherfold`: `run` and `index` on a restart with a changed processor now serve the incumbent's answers advancing through the upgrade window, and `/status` reports both the incumbent and the successor while both are held.

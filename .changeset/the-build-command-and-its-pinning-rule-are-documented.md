---
'etherfold': patch
---

**The build command an author must run is documented in one place, with the PINNING rule that makes a bundle's identity reproducible** (ADR-0086).

A processor is named by the sha256 of its bundle, so producing that bundle is the step before every folding command and the flags in the command are part of the name. `packages/cli/README.md` now states it once, under `Building the bundle`, and the rest of the tree points at it rather than repeating it.

**`--minify` is documented as MANDATORY, and the reason is IDENTITY rather than size.** Un-minified, esbuild opens each bundled module with a `// <path>` banner naming it RELATIVE TO THE DIRECTORY THE BUNDLER RAN IN, so the building machine's layout lands in the bytes. Measured: one source built from a checkout root and from its package directory hashes differently un-minified and identically minified (`docs/spikes/the-build-command-and-its-pinning-rule-are-documented/`, a script that re-runs the measurement). Drop the flag and a laptop and a CI job do not build a bigger bundle, they disagree about which generation they are, so neither reuses the state the other folded.

**What gets pinned is the bundler's VERSION AND ITS FLAGS, not merely the tool**, because the output is a function of both and the output is the identity. `rollup` is named as the alternative for anyone who wants it; `tsup` is not recommended, being esbuild with a wrapper that adds a version to pin and no determinism. Source maps are covered per spelling rather than with one sentence that is false for the default: `--sourcemap=external` leaves the bundle byte-identical (measured), while plain `--sourcemap` appends a `//# sourceMappingURL=` comment and so names a different generation.

**The documentation and the refusal cannot drift apart.** An author meets the refusal first and the documentation second, so `packages/cli/test/theDocsAndTheRefusalNameOneBuildCommand.test.ts` holds three copies of the command -- the CLI README's canonical statement, the example's worked instance, and the `build:bundle` script that actually runs -- to the command `refuseUnbundledProcessor` emits, flag for flag and in order.

The CLI README also gains a migration note for an author who had a working `-p` before bundling was required: what changed, and the one command to run.

Documentation only; no published behaviour changes.

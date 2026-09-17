# The processor bundle fixtures

`nfts.bundle.js` and `nfts-edited.bundle.js` are REAL processor bundles, committed, and they are what `test/aDeploymentRunsFromABundle.test.ts` points a deployment at. A deployment configured with one of them reads it, hashes it, instantiates it and folds blocks through it end to end, exactly as a deployment configured with a module path does (ADR-0086).

They are committed rather than built during the test run for the reason `packages/utils/test/fixtures/processor-artifact/README.md` gives: a bundler in the test path makes the suite depend on a toolchain version and on network-installed binaries, and the BYTES are the fixture. An artifact built on the fly by the same process that checks it can only tell you that the two agree with each other.

## The PAIR is the point

The two bundles are the same file with ONE HANDLER LINE CHANGED (`source/nfts.ts` credits the `nft` row to `to`, `source/nftsEdited.ts` to `from`). Everything a DECLARED identity is computed from is identical between them: the same `version`, the same entity declarations, the same contract data. So `getVersionHash()` cannot tell them apart and the bundle hash can, which is the silent-wrong-state failure ADR-0086 exists to delete, asserted as a property rather than described.

`source/abi.ts` is a sibling module both entry points import, so each artifact is genuinely a BUNDLE with a closure flattened into it rather than a single file that happened to need nothing.

## How they were built

From `packages/cli`, with the command ADR-0086's family documents (esbuild 0.28.1, the version this workspace pins):

```sh
esbuild test/fixtures/processor-bundle/source/nfts.ts \
  --bundle --format=esm --minify \
  --outfile=test/fixtures/processor-bundle/nfts.bundle.js
esbuild test/fixtures/processor-bundle/source/nftsEdited.ts \
  --bundle --format=esm --minify \
  --outfile=test/fixtures/processor-bundle/nfts-edited.bundle.js
```

This package does not depend on esbuild, so reach for the workspace's copy (`../utils/node_modules/.bin/esbuild`) rather than adding a dependency a deployment would then carry: nothing in the CLI bundles anything, and reading a file and hashing it is not bundling.

Rebuild with exactly that command if the sources change. `--minify` is not a size preference: un-minified esbuild output carries a `// <path>` banner per module, so the BUILDING MACHINE'S DIRECTORY LAYOUT ends up in the bytes and two machines building one source disagree about which generation they are. It is also why both files are listed in the repo's `.prettierignore` -- reformatting an artifact would give it a new identity while changing nothing about what it does.

No test pins either hash. Identity is asserted as a PROPERTY (identical bytes, identical generation; one changed handler, a different one), so a rebuild with a newer esbuild is not a test failure.

## What is in them

`createProcessor`, which is what a host looks for, and `contractsDataPerChain`, which is what the CLI resolves its indexing source from -- so a deployment pointed at one of these needs no `--deployments` folder and exercises the ordinary source resolution on its way to a fold. The declared `version` is still there because the entity runtimes refuse a processor without one until the contract task deletes the field; it is not what identifies the artifact and it is deliberately the same in both.

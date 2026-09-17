# The processor artifact fixture

`processor.bundle.js` is a REAL processor bundle, committed, and it is what `test/processorArtifact.test.ts` hashes, admits and instantiates.

It is committed rather than built during the test run for two reasons. A bundler in the test path makes the suite depend on a toolchain version and on network-installed binaries for a 258-byte artifact; and the bytes are the fixture. An artifact built on the fly by the same process that checks it can only tell you that the two agree with each other, which is exactly the circularity a committed artifact removes.

## How it was built

From `packages/utils`, with the command ADR-0086's family documents (esbuild 0.28.1):

```sh
pnpm exec esbuild test/fixtures/processor-artifact/source/processor.ts \
  --bundle --format=esm --minify \
  --outfile=test/fixtures/processor-artifact/processor.bundle.js
```

Rebuild it with exactly that command if the source changes. `--minify` is not a size preference: un-minified esbuild output carries a `// <path>` banner per module, so the BUILDING MACHINE'S DIRECTORY LAYOUT ends up in the bytes and two machines building one source disagree about which generation they are. It is also why this file is listed in the repo's `.prettierignore` -- reformatting the artifact would give it a new identity while changing nothing about what it does.

No test pins the resulting hash. Identity is asserted as a PROPERTY (identical bytes, identical name; one changed byte, a different name), so a rebuild with a newer esbuild is not a test failure, and the one value that is pinned is the published SHA-256 of the empty input, which pins the rendering rather than this artifact.

## What is in it

`source/processor.ts` is the narrowest processor that can be OBSERVED folding: one entity declaration and one handler that writes through a mutation seam, plus `source/tokenKey.ts`, a sibling module, so the artifact is genuinely a BUNDLE with a closure flattened into it. It exports `createProcessor`, which is the one thing a host looks for.

A deployment's real bundle also exports contract data (`contractsData` / `contractsDataPerChain`); nothing in the artifact unit reads it, so this fixture carries none.

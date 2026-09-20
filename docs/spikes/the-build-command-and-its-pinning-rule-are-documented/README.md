# What lands in a bundle's bytes, and therefore in its identity

Evidence for the documented build command in [`packages/cli/README.md`](https://github.com/wighawag/etherfold/blob/main/packages/cli/README.md#producing-the-processor-bundle). A processor is named by the sha256 of its bundle ([ADR-0086](../../adr/0086-a-processors-identity-is-derived-from-its-code-and-never-declared.md)), so a flag that changes the output changes which GENERATION a deployment is, and an author needs to know which flags those are before they are told to pin them.

Three claims the documentation makes are measured here rather than asserted, by hashing real esbuild output:

```sh
ESBUILD=packages/utils/node_modules/.bin/esbuild \
  docs/spikes/the-build-command-and-its-pinning-rule-are-documented/measure-what-lands-in-the-bytes.sh
```

One source is built twice, from two different working directories and nothing else different, which is the developer-versus-CI case: the same checkout, reached by a different relative path.

## Result, esbuild 0.28.1 on Linux, 2026-09-18

| build | sha256 |
| --- | --- |
| un-minified, from the checkout root (`esbuild src/entry.js`) | `f2d21373…` |
| un-minified, from the package directory (`esbuild entry.js`) | `bce77ea9…` |
| **minified, from the checkout root** | `bfbbcd68…` |
| **minified, from the package directory** | `bfbbcd68…` |
| minified, `--sourcemap` (linked) | `111c3db4…` |
| minified, `--sourcemap=external` | `bfbbcd68…` |

**Un-minified output carries the path of every module it bundled, relative to the directory the bundler ran in.** The two un-minified builds open with `// src/abi.js` and `// abi.js` respectively and hash differently, from one source with one content. That is the whole of why `--minify` is mandatory: without it the identity is a function of WHERE the build ran, so a developer and CI disagree about which generation they are, persisted state is never reused, and every deploy re-folds. Stripping comments, which is the reason someone would guess the flag is there, is the lesser benefit.

**Minified output is identical from both directories**, which is the property the identity rests on.

**A LINKED source map moves the identity; an EXTERNAL one does not.** `--sourcemap` appends `//# sourceMappingURL=minified-sourcemap-linked.js.map` to the bundle, so the bytes differ from the same build without it. `--sourcemap=external` writes the same `.js.map` beside the bundle and omits the comment, leaving the bundle byte-identical to the map-less build (`bfbbcd68…`, equal to both minified rows above). So source maps ARE available as the answer to a minified stack trace, and the honest statement is per spelling rather than "source maps do not affect the identity".

Note what a linked map does NOT do: it does not make the identity machine-dependent, since the appended URL is the output's own basename. It simply names a different generation from the map-less build of the same source, which is why the flag set and not merely the tool is what gets pinned.

## What this does not cover

**Whether two esbuild VERSIONS agree.** The same trivial input hashed identically under 0.21.5 and 0.28.1 while this was being measured, and that is not a property to lean on: output is a function of the bundler's own code, so a version bump may re-emit identical behaviour under different bytes. That possibility is the reason the version belongs in the lockfile, and measuring one agreement would only invite someone to skip the pin.

**`rollup`.** It is named in the documentation as the alternative for an author who wants it, and its output is its own function of version and configuration; nothing here measures it.

# @etherfold/utils

The Node-side glue between a **processor an operator named** and the runtime that drives it: load it -- from a path on disk, or from the BYTES of a bundle -- get the processor out of it, and work out which contracts it is meant to index.

This is host code, not engine code. It reads the filesystem (`node:fs`, `node:module`), so it belongs to a CLI or a server and not to a browser bundle.

## When you want this package

You are writing a HOST that takes a processor path from an operator: `-p ./dist/processor.js`, an environment variable, a job definition. [`etherfold`](https://github.com/wighawag/etherfold/tree/main/packages/cli) is built on it. If your processor is `import`ed by name in your own source, you do not need any of this: hand the object to [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities) directly.

## Loading a processor

```ts
import {resolveProcessorAndSource} from '@etherfold/utils';
import type {EntityProcessor} from '@etherfold/processor-entities';

const {processor, source} = await resolveProcessorAndSource<Abi, unknown, EntityProcessor<Abi>>({
	processorPath: './dist/processor.js',
	provider, // used only to ask `eth_chainId`, and only when the module keys contracts per chain
});
```

That is the three steps composed. They are also separately available, because a host that already knows its source only wants the first two:

- **`loadProcessorModule(path, {cwd, importModule, requireResolve})`** imports the module. An absolute path is imported as-is; a relative one is joined against `cwd` and, failing that, resolved through `createRequire(cwd/node_modules)` so a bare package specifier still works.
- **`instantiateProcessor(module, {processorPath, processorConfig})`** calls the module's `createProcessor` (or uses it as-is when it is already an object) and hands back **what it made, unread**: the AUTHORING object, declarations plus handlers. It deliberately does NOT build a runtime, because that would mean picking a store, and where the state lives is the HOST's decision -- which is exactly what lets one processor file run in a tab and on a server. The caller supplies the type it expects; a module still returning the retired `{kind, processor}` tag is REFUSED by name (ADR-0037) rather than unwrapped.
- **`resolveSource(module, provider)`** reads `contractsDataPerChain[chainId]` (fetching `eth_chainId` only when that field exists) and falls back to `contractsData`.

## Loading a processor from BYTES

The other arrival: a processor that is a self-contained ESM bundle rather than a path, whose IDENTITY is the hash of its own octets (ADR-0086) because an author cannot be trusted to remember one and should not have to.

```ts
import {loadProcessorArtifact, processorArtifactIdentity} from '@etherfold/utils';

const bundle = new Uint8Array(await readFile('./dist/processor.bundle.js'));
const outcome = await loadProcessorArtifact<Abi, unknown, EntityProcessor<Abi>>(bundle);
if (outcome.status === 'refused') {
	console.error(`${outcome.identity} is not a processor artifact (${outcome.reason}): ${outcome.why}`);
} else {
	// outcome.identity names the generation this processor folds; nothing parses it.
}
```

- **`processorArtifactIdentity(bytes)`** is SHA-256 over the octets, rendered `sha256:<hex>` so a value pasted into a build says which function produced it. Identical bytes always give an identical name, and one changed byte gives a different one, with no author action either way.
- **`unresolvedImportsOf(bytes)`** is what SELF-CONTAINED means, checked rather than promised: every module the bundle still expects somebody else to resolve, bare (`viem`) and relative (`./abi.js`) alike, statically, including a specifier only a dynamic `import()` carries. A builtin (`node:crypto`, or `crypto`) is admitted because a `data:` URL really does resolve one -- [measured](https://github.com/wighawag/etherfold/tree/main/docs/spikes/a-processor-artifact-is-bytes-a-hash-and-a-loader).
- **`loadProcessorArtifact(bytes, {processorConfig})`** hashes, admits and then instantiates, in that order, by importing a `data:` URL: no temporary file, no path, no cache-busting query. Every refusal comes back as DATA (`not-self-contained`, naming the specifiers; `unreadable-module`; `not-a-processor`) carrying the artifact's identity, because an artifact arrives from somewhere else and "these bytes are not a processor" is an ordinary thing to learn.

A bundle is produced by the author and not by any host here (reading a file and hashing it is not bundling): `esbuild <entry> --bundle --format=esm --minify`, where `--minify` is mandatory for the identity to be stable across machines rather than for size.

This arrival is for a CLI or a server. A browser is handed a processor OBJECT by its own bundler, and where a tab does hold bytes, `data:` and `blob:` imports are refused by every realistic Content-Security-Policy, so there is deliberately no browser path here.

## One PATH, whichever arrival it turns out to be

A host takes one `-p <path>` from an operator and should not have to ask which of the two shapes above it named. `openProcessorArrival` answers that, and it is what [`etherfold`](https://github.com/wighawag/etherfold/tree/main/packages/cli) calls:

```ts
import {openProcessorArrival} from '@etherfold/utils';

const arrival = await openProcessorArrival<Abi, unknown, EntityProcessor<Abi>>('./dist/processor.bundle.js');
// arrival.processor, arrival.processorModule, and:
if (arrival.identity) {
	// the path named a BUNDLE: this is `sha256:<hex>` over its octets, and it NAMES the
	// generation the host is about to register. Nothing parses it. `arrival.bundle` is
	// those very octets, which a Node deployment STORES with the generation (ADR-0092).
}
```

A path whose bytes are **self-contained** is a bundle, read and hashed. Anything else -- a specifier that is not a readable file, a directory, an entry point that still imports its ABI -- goes through `loadProcessorModule` exactly as before and comes back with **no identity**, which is a fold nothing here can name: the author-declared identity this route used to fall back on is gone (ADR-0086), so `etherfold` REFUSES such a deployment. The refusal an author meets is made at CONFIGURATION RESOLUTION, with the build command in it (`refuseUnbundledProcessor`), and a structural backstop (`requireArrivedBundle`) guarantees no fold is registered without a name and the bytes that name it, whatever route the arrival took. Neither refusal lives here, because resolving a path is a separate capability from NAMING what came back and this unit does the first. `identity` is therefore read as present-or-absent and never inspected as a string: nothing in etherfold parses a processor identity, which is what lets an identity derived from bytes and one derived any other way coexist.

The consequence worth knowing: an entry point that imports NOTHING is self-contained, so it is a bundle by this definition and is identified by its bytes. An injected `importModule` governs the module arm alone; to state what the BYTES are, inject `readBundle`.

## Loading contracts from a deployments folder

For the `-d ./deployments/sepolia` case, where the ABIs and addresses are build artifacts rather than something the processor module carries:

```ts
import {loadContracts} from '@etherfold/utils';

const source = loadContracts('./deployments/sepolia'); // an IndexingSource
```

It takes a folder or a single file in hardhat-deploy / rocketh format: every `*.json` with an `address` becomes a contract, `.chainId` or `.chain` supplies the chain id (and the genesis hash), two artifacts at one address are merged with the LOWEST `startBlock`, and a missing or non-numeric chain id is refused.

`filterOutFieldsFromObject`, `filterOutUnderscoreFieldsFromObject`, `clean` and `removeUndefinedValuesFromObject` are the small object helpers that live here beside them.

## Related

[`@etherfold/core`](https://github.com/wighawag/etherfold/tree/main/packages/core) for the `IndexingSource` these functions produce, [`@etherfold/processor-entities`](https://github.com/wighawag/etherfold/tree/main/packages/processor-entities) for what a processor module should export, and [`etherfold`](https://github.com/wighawag/etherfold/tree/main/packages/cli) for a host that wires all of it together.

## Tests

`pnpm --filter @etherfold/utils test`, vitest.

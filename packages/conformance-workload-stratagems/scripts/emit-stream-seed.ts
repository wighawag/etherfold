/**
 * EMIT the committed reference stream seed, and print what a build would pin.
 *
 * `pnpm --filter @etherfold/conformance-workload-stratagems emit:seed`
 *
 * A manual step, like the capture it reads (`../fixtures/README.md`), and for a
 * blunter reason: the artifact it writes is COMMITTED, so re-emitting it is a
 * change to a deliverable and belongs in a diff somebody looked at. It is
 * deterministic -- the same capture and the same inputs produce the same bytes,
 * because the producer dates the seed by when the EVENTS were produced rather
 * than by when the file was written -- so a re-emit of an unchanged capture
 * shows no diff at all, and any diff is a real one.
 *
 * This is deliberately NOT a published CLI command and it builds no part of a
 * publishing pipeline (hosting, CI, retention, permissions), which the spec that
 * asked for it keeps out of scope. It turns one capture into one file.
 *
 * What it prints is the point of the exercise: the stream DIGEST (which a client
 * recomputes and compares against its own before installing anything, ADR-0064)
 * and the CONTENT HASH (`sha256:<hex>` over the DECOMPRESSED octets, ADR-0066,
 * which a build MAY pin for an immutable release-tied artifact and which a
 * client recomputes over the bytes it received after any transfer decoding).
 */
import {ALPHA1, alpha1SeedInputs, loadStream, saveStreamSeed, streamSeedFrom} from '../src/index.js';

const seedPath = ALPHA1.seedPath;
if (!seedPath) {
	throw new Error(`${ALPHA1.name} declares no seedPath`);
}

console.log(`reading ${ALPHA1.streamPath}`);
const capture = loadStream(ALPHA1);
const seed = streamSeedFrom(capture, alpha1SeedInputs(capture));
const emitted = saveStreamSeed(seedPath, seed);

/**
 * MEBIbytes, because that is the unit
 * `work/notes/findings/what-a-published-stream-seed-costs-to-install.md` measured
 * in: a number printed here is meant to be compared against that table, and two
 * units would read as a 5% discrepancy that is not there.
 */
const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(2)} MiB (${bytes} bytes)`;

console.log(`
wrote ${emitted.path}
  events           ${emitted.events}
  coverage         ${seed.coverage.fromBlock} -> ${seed.coverage.toBlock} (head at capture ${seed.chainHeadAtCapture})
  gzipped          ${mb(emitted.fileBytes)}
  raw payload      ${mb(emitted.payloadBytes)}

what a build pins:
  streamDigest     ${emitted.streamDigest}
  contentHash      ${emitted.contentHash}

  The content hash is SHA-256 over the DECOMPRESSED payload octets: the bytes as
  they exist after any transfer decoding and before JSON.parse (ADR-0066). It is
  therefore transport-invariant -- a host may serve this file opaque or with
  Content-Encoding: gzip and a client reaches the same value either way.
`);

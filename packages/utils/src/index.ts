export * from './contracts.js';
export * from './javascript.js';
export * from './processorSetup.js';
/**
 * THE PROCESSOR ARTIFACT: bytes, the identity derived from them, and the loader
 * that turns them into a running processor without touching a filesystem.
 *
 * Beside `processorSetup.js` rather than inside it, because it is a different
 * ARRIVAL and not a variation of one: that module takes a PATH an operator named
 * and resolves it through the module system, this one takes BYTES that carry
 * their own name (ADR-0086) and resolve nothing. What they share is the
 * module-shape rule, which `instantiateProcessor` owns and this one reuses.
 */
export * from './processorArtifact.js';
/**
 * THE ARRIVAL: one operator-supplied PATH, landing on whichever of the two units
 * above it turns out to describe, with the identity coming from the artifact
 * where there is one.
 *
 * Last, because it is the only thing here that knows about both: the two units it
 * chooses between name each other nowhere, which is what keeps "bytes that carry
 * their own name" and "a specifier the module system resolves" two answers rather
 * than one with a flag.
 */
export * from './processorArrival.js';

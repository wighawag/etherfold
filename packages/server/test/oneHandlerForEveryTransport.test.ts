import {describeStateMovedConformance} from '@etherfold/state-moved-conformance';
import {openServerTransport} from './utils/stateMovedTransport.js';

/**
 * ONE HANDLER, EVERY TRANSPORT -- the network half.
 *
 * ADR-0083's claim is that a `MessagePort`, a `BroadcastChannel` and this
 * server's stream are ADAPTERS over one notification model, so that pointing an
 * app at a hosted indexer instead of at its own browser worker changes a
 * DEPLOYMENT CHOICE and not a line of its notification handling. That is not
 * checkable inside one package: the other two transports are
 * `@etherfold/browser`'s, and three adapters that each pass the tests in their
 * own file is exactly what drift looks like the day before anyone notices.
 *
 * So the cases are DATA, in `@etherfold/state-moved-conformance`, and this file
 * is a thin runner over the transport this package owns. What is asserted HERE,
 * by contrast, is everything that is this transport's ALONE and no other
 * transport has an opinion about -- the two refusals, the frame names, the
 * progress figures, the per-client bookkeeping -- and that lives in
 * `aRemoteClientLearnsTheStateMoved.test.ts` beside it.
 */

await describeStateMovedConformance('across a SERVER\u2019s state-moved stream', openServerTransport);

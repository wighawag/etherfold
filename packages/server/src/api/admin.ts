import {generationDigestOf, type GenerationId, type GenerationRecord} from '@etherfold/core';
import {Hono} from 'hono';
import type {Context} from 'hono';
import {logs} from 'named-logs';
import type {Env} from '../env.js';
import type {IndexerRegistryEntry, ReconfigureReport} from '../registry.js';
import {authorizedWith} from './auth.js';
import {resolveIndexer} from './resolve.js';
import {setup} from '../setup.js';
import type {ServerOptions} from '../types.js';

const logger = logs('@etherfold/server');

/**
 * THE OPERATOR'S SURFACE ON ONE NAMED INDEXER: which generation answers reads,
 * moving that pointer -- forwards to promote, BACK to revert -- and the TRIGGER
 * that introduces a generation to move to in the first place.
 *
 * The two belong together and arrived in that order for a reason. Everything
 * downstream of "a successor exists" was built and careful before anything could
 * introduce one to a RUNNING process: a generation was registered when a
 * container OPENED, from configuration, so a changed processor reached a
 * deployment by restarting it. `reconfigure` is the missing half, and it sits
 * here rather than anywhere else because it is the same operator, the same
 * segment and the same credential as the move.
 *
 * ## Why this is an HTTP route and not a command
 *
 * It is the only affordance that exists on EVERY deployment shape. On Cloudflare
 * there is no CLI at all -- a Worker is reachable only over HTTP -- so a flag on
 * a command could not serve a serverless deployment, and a library call with no
 * operator surface does not deliver the story at all. The command set is pinned
 * at five verbs with no default command, so a sixth is unavailable, and hanging
 * `--revert` on `run` would conflate a long-running fold with a one-shot control
 * action.
 *
 * `/admin/setup` already exists, so `/admin` is an ESTABLISHED namespace rather
 * than a new class of surface -- and that is what matters, because the
 * milestone's "add no endpoint" fence protects the QUERY surface (`/status` is
 * the whole of it), not the admin one. What is new is the `/{indexer}` prefix on
 * it: `setup` is host-level (it migrates the fixed tables and knows no name),
 * while a pointer belongs to ONE named indexer, so it hangs off the same route
 * segment every other per-name surface does.
 *
 * ## The credential is its OWN, and it fails closed
 *
 * `ADMIN_TOKEN`, refusing everyone when unset, exactly as the ingest guard does.
 * It is deliberately NOT `INGEST_TOKEN`: that credential is handed to a log
 * shipper and guards the WRITE path, and letting it also change which generation
 * answers reads would give a fetcher control-plane authority over the deployment
 * it feeds. The guard sits on the PATH rather than inside the handlers, ahead of
 * the registry lookup, so an unknown name answers `401` to an unauthenticated
 * caller: which names a host was built with is not something an anonymous caller
 * may enumerate.
 *
 * ## The MOVE is one small write, and this route decides none of it
 *
 * Every rule belongs to the generation registry and the container over it
 * (`@etherfold/core`): that a generation nothing registered is REFUSED, that the
 * pointer is never unset, that a BACKWARDS move drops nothing, and that a target
 * this host holds no FOLD for is answered anyway (reads resolve the pointer to a
 * table NAMESPACE, ADR-0053, so the reverted-to generation answers with no engine
 * at all -- which is the ordinary case on a host redeployed with the new
 * processor alone). What this route adds is the transport's own two decisions:
 * WHO may call it, and WHICH status code each refusal is.
 */
export function getAdminAPI<CustomEnv extends Env>(options: ServerOptions<CustomEnv>) {
	return (
		new Hono<{Bindings: CustomEnv}>()
			.use(setup({serverOptions: options}))
			.use('/:indexer/admin/*', async (c, next) => {
				const auth = authorizedWith(c as never, 'ADMIN_TOKEN');
				if (!auth.ok) {
					return c.json({success: false, error: 'unauthorized', message: auth.message} as const, 401);
				}
				return next();
			})
			/**
			 * WHICH GENERATION ANSWERS READS, and every generation there is to point at.
			 *
			 * The read half of the pointer, and the thing that makes the write half
			 * usable: a feed response advertises its generation as an OPAQUE digest
			 * (compared, never parsed), so an operator matches that value against this
			 * listing rather than reconstructing `{stream, processor}` from it. Each entry
			 * carries BOTH forms for that reason -- the digest to recognise it by, and the
			 * two fields the move below takes.
			 *
			 * The `canonical` flag on each entry is a REPORT at the moment of asking and not
			 * a consistent snapshot with the listing beside it: the entry answers the two
			 * questions separately, and a pointer that moved between them is a race an
			 * operator's own next call resolves. It is deliberately not worth a combined read
			 * here, unlike the FEED, where pairing one generation's stream with another's
			 * fold would be a wrong ANSWER rather than a stale listing.
			 *
			 * An indexer with NO canonical generation is REPORTED here rather than refused,
			 * which is the opposite of what a READ does with the same answer and is the right
			 * way round: a read served from nothing would be a wrong answer, while "nothing
			 * answers reads yet, and here is what is registered" is precisely the state an
			 * operator opened this route to see.
			 */
			.get('/:indexer/admin/canonical-generation', async (c) => {
				const held = await resolveHeld(options, c as never);
				if (!held.ok) return held.response;

				const generations = await held.generations();
				const canonical = await held.entry.canonicalGeneration();
				return c.json({
					success: true,
					indexer: held.name,
					canonical: canonical ? reported(canonical) : undefined,
					generations: generations.map((record) => ({
						...reported(record),
						createdAt: record.createdAt,
						canonical: !!canonical && record.stream === canonical.stream && record.processor === canonical.processor,
					})),
				} as const);
			})
			/**
			 * MOVE THE POINTER: the promotion and the revert, which are one write in two
			 * directions.
			 *
			 * A `POST` on the same path the `GET` reads, because it is the same object:
			 * this names WHICH generation answers reads, and there is deliberately no
			 * second verb for the backwards direction -- moving the pointer IS promotion
			 * and moving it back IS revert, and two verbs would be two names for one
			 * record write that could drift apart in what they were allowed to do.
			 */
			.post('/:indexer/admin/canonical-generation', async (c) => {
				const held = await resolveHeld(options, c as never);
				if (!held.ok) return held.response;

				let body: unknown;
				try {
					body = await c.req.json();
				} catch (err) {
					return c.json(
						{
							success: false,
							error: 'invalid-generation',
							message: `this request body is not JSON: ${err instanceof Error ? err.message : String(err)}`,
						} as const,
						400,
					);
				}
				const target = generationIn(body);
				if (!target) {
					return c.json(
						{
							success: false,
							error: 'invalid-generation',
							message:
								`name the generation to point at as {"stream": "<digest>", "processor": "<version hash>"}, both ` +
								`non-empty strings. GET this path for the generations this indexer holds, each with the digest a ` +
								`feed response advertises it by.`,
						} as const,
						400,
					);
				}

				const generations = await held.generations();
				const known = generations.find(
					(record) => record.stream === target.stream && record.processor === target.processor,
				);
				if (!known) {
					// REFUSED rather than reported as a silent success, and every generation
					// this name holds is NAMED rather than one being picked -- the same shape
					// `GenerationCapReachedError` has, because naming them all is information
					// and picking one would be a policy this has no basis for.
					logger.error(
						`admin: ${JSON.stringify(held.name)} was asked to point at a generation it does not hold ` +
							`({stream: ${target.stream}, processor: ${target.processor}})`,
					);
					return c.json(
						{
							success: false,
							error: 'unknown-generation',
							indexer: held.name,
							requested: reported(target),
							generations: generations.map(reported),
							message:
								`this named indexer holds no generation {stream: ${target.stream}, processor: ` +
								`${target.processor}}. It is refused rather than answered, because a pointer moved to a ` +
								`generation that is not there would leave this indexer answering from nothing. The generations ` +
								`it does hold are listed as \`generations\`.`,
						} as const,
						400,
					);
				}

				const previous = await held.entry.canonicalGeneration();
				const moved = await held.promote(target);
				logger.info(
					`admin: the canonical pointer of ${JSON.stringify(held.name)} now names {stream: ${moved.stream}, ` +
						`processor: ${moved.processor}} (it named ` +
						`${previous ? `{stream: ${previous.stream}, processor: ${previous.processor}}` : 'nothing'})`,
				);
				return c.json({
					success: true,
					indexer: held.name,
					// what answered reads BEFORE this call, so an operator undoing a mistake
					// has the value to send back without reading anything else. ABSENT when this
					// move is the FIRST thing to answer reads here, because there is nothing to
					// undo back to.
					previous: previous ? reported(previous) : undefined,
					canonical: reported(moved),
				} as const);
			})
			/**
			 * THE TRIGGER: make this deployment RE-READ its own configuration and register
			 * whatever generation that now names, beside the incumbent.
			 *
			 * ## Why an endpoint, and why it takes NOTHING
			 *
			 * Whatever notices a file changed lives OUTSIDE the process. A file watcher
			 * inside the indexer would be development tooling by construction, which is what
			 * makes it tempting to gate behind a development flag and then need a second
			 * mechanism for production; an endpoint is called by a dev watcher, a deploy hook
			 * or a CI step equally. And it is RE-READ rather than RECEIVE because a processor
			 * is CODE and cannot cross HTTP: the watcher owns WHEN, the process owns WHAT. So
			 * there is no body, and a body would be a format for shipping code that nobody
			 * should invent.
			 *
			 * It sits under the SAME `/{indexer}/admin/` segment as the pointer move and
			 * therefore under the same `ADMIN_TOKEN` guard: handing a remote caller the
			 * ability to START a fold reuses the existing authorisation story rather than
			 * opening a second one, and it is deliberately never the ingest credential.
			 *
			 * ## This route DECIDES nothing about the reload
			 *
			 * Exactly as the pointer move above decides nothing about the move. This package
			 * names no runtime, so it resolves no module and reads no configuration; what a
			 * re-read MEANS belongs to the host that assembled the fold, behind
			 * `IndexerRegistryEntry.reconfigure`. What this adds is the transport's own two
			 * decisions: who may call it, and which status each answer is.
			 *
			 * ## THE THREE ANSWERS, and why they are three
			 *
			 * Because "I saved the file and nothing happened" otherwise has three
			 * indistinguishable causes. `registered` NAMES the generation (`200`);
			 * `unchanged` is a SUCCESS that says the configuration named the generation this
			 * deployment already holds (`200`, with the reason, and with `drift` when the
			 * handler code moved under an unchanged `version` -- see `ReconfigureReport`);
			 * `failed` refuses (`409`), names what went wrong, and promises the deployment is
			 * exactly as it was.
			 *
			 * `409` and none of this surface's other refusals: nothing about the REQUEST is
			 * wrong so it is not the `400` family, the name resolved so it is not the `404`,
			 * and the capability is present so it is not the `501` beside it. What is true is
			 * that the deployment's CURRENT state conflicts with performing this, and that a
			 * caller which fixes that state and re-sends the identical request will be
			 * served -- which is what this repo already spends `409` on, as the ONE resumable
			 * refusal on the wire (ADR-0004). A broken processor is the normal state between
			 * the two halves of one change, so a watcher meeting this is expected to build
			 * again and call again seconds later.
			 *
			 * A host that THREW is reported as the same failure rather than as a `500`: the
			 * caller's situation is identical (the re-read did not happen, the deployment is
			 * untouched, try again after fixing it), and making a watcher distinguish an
			 * exception from a refusal would be asking it to guess.
			 */
			.post('/:indexer/admin/reconfigure', async (c) => {
				const resolved = resolveIndexer(options, c as never, 'admin');
				if (!resolved.ok) return resolved.response;
				const {entry, name} = resolved;

				const reconfigure = entry.reconfigure;
				if (!reconfigure) {
					// A CAPABILITY this deployment lacks and NOT a route that is missing, which
					// is the same `501` an absent pointer or an absent ingestion answers. It is
					// deliberately independent of `generations`/`promote`: a read tier holds a
					// database somebody else writes and no processor at all, and a host may hold
					// a registry it can move a pointer in with nothing to re-read FROM.
					logger.error(`admin: ${JSON.stringify(name)} cannot re-read its configuration, so a reconfigure was refused`);
					return c.json(
						{
							success: false,
							error: 'reconfigure-not-held',
							indexer: name,
							message:
								`this named indexer cannot re-read its own configuration, so there is nothing here to trigger: it ` +
								`was registered by a host that resolves no processor module of its own -- a read tier answers over a ` +
								`database written elsewhere, and a receiving host is handed its fold rather than reading one. A ` +
								`deployment that serves this registers a re-read alongside what it holds (\`etherfold run\`).`,
						} as const,
						501,
					);
				}

				let report: ReconfigureReport;
				try {
					report = await reconfigure.call(entry);
				} catch (err) {
					// SAME ANSWER as a reported failure, because the caller's situation is the
					// same one. A host is expected to report its own failure as data (the load
					// that did not compile is the EXPECTED case, not an exception), and this is
					// what keeps a host that did not still honest to the watcher.
					report = {outcome: 'failed', message: err instanceof Error ? err.message : String(err)};
				}

				if (report.outcome === 'failed') {
					logger.error(
						`admin: ${JSON.stringify(name)} could not re-read its configuration (${report.message}). Nothing was ` +
							`registered and the deployment is as it was.`,
					);
					return c.json(
						{
							success: false,
							error: 'reconfigure-failed',
							indexer: name,
							outcome: 'failed',
							message: report.message,
						} as const,
						409,
					);
				}

				if (report.outcome === 'unchanged') {
					logger.info(
						`admin: ${JSON.stringify(name)} re-read its configuration and it named {stream: ` +
							`${report.generation.stream}, processor: ${report.generation.processor}}, which it already holds, so ` +
							`NOTHING was registered`,
					);
					return c.json({
						success: true,
						indexer: name,
						outcome: 'unchanged',
						generation: reported(report.generation),
						message: report.message,
						// CARRIED VERBATIM, because the watcher reading this is the developer's own
						// window: the message already says it in words, and the two fingerprints are
						// what a tool compares between saves. Absent when there is nothing to say, which
						// is what keeps "this really was a no-op" readable as itself.
						...(report.drift ? {drift: report.drift} : {}),
					} as const);
				}

				logger.info(
					`admin: ${JSON.stringify(name)} re-read its configuration and REGISTERED {stream: ` +
						`${report.generation.stream}, processor: ${report.generation.processor}} beside what answers reads`,
				);
				return c.json({
					success: true,
					indexer: name,
					outcome: 'registered',
					// the generation it registered, in the two fields the pointer move takes and
					// the opaque digest a feed response advertises it by -- so the value this
					// answers with is the value an operator matches or promotes, with nothing to
					// reconstruct.
					generation: reported(report.generation),
				} as const);
			})
	);
}

/** A generation as this surface reports one: the two fields that KEY it, and the digest it is ADVERTISED by. */
function reported(id: GenerationId): {stream: string; processor: string; digest: string} {
	return {stream: id.stream, processor: id.processor, digest: generationDigestOf(id)};
}

/** The `{stream, processor}` a request named, or nothing if it named no generation. */
function generationIn(body: unknown): GenerationId | undefined {
	if (!body || typeof body !== 'object') return undefined;
	const {stream, processor} = body as {stream?: unknown; processor?: unknown};
	if (typeof stream !== 'string' || stream.length === 0) return undefined;
	if (typeof processor !== 'string' || processor.length === 0) return undefined;
	return {stream, processor};
}

/**
 * The named indexer this request addressed AND the generations it holds, or the
 * refusal to send back.
 *
 * The two `IndexerRegistryEntry` questions this surface needs are OPTIONAL on the
 * entry, so a host that holds one fold and no registry (`singleContextEntry`, the
 * Worker host, a test) has no pointer to move. That is a CAPABILITY this
 * deployment lacks rather than a route that is missing, which is the same `501`
 * the ingest routes answer on a host with no registry at all -- and deliberately
 * a different answer from the `404` for a name this host was not built with.
 */
async function resolveHeld<CustomEnv extends Env>(
	options: ServerOptions<CustomEnv>,
	c: Context<{Bindings: Env}>,
): Promise<
	| {
			ok: true;
			name: string;
			entry: IndexerRegistryEntry;
			generations: () => Promise<readonly GenerationRecord[]>;
			promote: (id: GenerationId) => Promise<GenerationRecord>;
	  }
	| {ok: false; response: Response}
> {
	const resolved = resolveIndexer(options, c, 'admin');
	if (!resolved.ok) return resolved;
	const {entry, name} = resolved;
	const generations = entry.generations;
	const promote = entry.promote;
	if (!generations || !promote) {
		logger.error(`admin: ${JSON.stringify(name)} holds no generation registry, so its pointer cannot be moved`);
		return {
			ok: false,
			response: c.json(
				{
					success: false,
					error: 'generations-not-held',
					indexer: name,
					message:
						`this named indexer holds no generation registry, so there is no canonical pointer here to read or ` +
						`move: it runs ONE fold, and what answers reads is that fold. A host that holds generations ` +
						`registers a container that says which it holds and which one is canonical.`,
				} as const,
				501,
			),
		};
	}
	return {ok: true, name, entry, generations: () => generations.call(entry), promote: (id) => promote.call(entry, id)};
}

import type {EnvRecord} from '@etherfold/fetcher-host';
import {refuseUnbundledProcessor, resolveCommandConfig} from './config.js';
import type {Options, UploadConfig} from './types.js';

// ---------------------------------------------------------------------------------------------------
// `etherfold upload`: SEND AN ALREADY-BUILT BUNDLE TO A RUNNING NODE, AND SAY WHAT IT DID
// ---------------------------------------------------------------------------------------------------
// The SENDER half of The Graph's deploy shape (ADR-0085's amendment of 2026-09-22,
// and its decisions relocated from the upload spec): the bytes of a bundle the
// author has ALREADY built go to a running node's `POST /{indexer}/admin/upload`,
// and the node registers the generation they name beside the one answering reads.
// Everything after the request is the node's: the identity is ITS hash of the bytes
// (ADR-0086), the contract match is ITS, and the promotion policy that moves the
// pointer once the successor catches up is ITS configuration.
//
// ## It only uploads; it never builds
//
// Bundling is the author's (ADR-0085's amendment). `build` is the one-shot fold, and
// `deploy` is left free for a later build-and-upload command.
//
// ## The commonest mistake fails HERE, in the words it fails in everywhere
//
// A path naming an entry point, or a build that has not run, is refused on the
// author's machine BEFORE any request, by `refuseUnbundledProcessor` -- the check
// every folding command's `--processor` already goes through, over the repository's
// one definition of self-contained (`unresolvedImportsOf`). It is not re-implemented
// here, and the bytes it judged are the bytes that are sent, read once.
//
// ## THE EXIT CODE IS THE CONTRACT A PIPELINE READS
//
// `0` for `registered` and for `unchanged` -- an honest "that is already deployed"
// is a successful deploy, and a pipeline that re-runs on an unchanged commit must
// not go red. `1` for EVERYTHING else: a configuration refusal, the local
// self-containment refusal, every refusal the node answers (`401`, `413`, `415`,
// `409 upload-failed`, `501`), any other status or a body that is not the route's
// report, and a node that could not be reached at all. Anything short of a
// registration or an honest `unchanged` fails the pipeline, with the node's reason
// printed where a CI log shows it.
// ---------------------------------------------------------------------------------------------------

/** The node's answer, as the route reports a generation. */
export type UploadedGeneration = {readonly stream: string; readonly processor: string; readonly digest: string};

/**
 * WHAT AN UPLOAD CAME TO, as data a caller branches on.
 *
 * `deployed` is the one bit a pipeline reads: true for `registered` and `unchanged`,
 * false for every refusal the node answered and for a node nobody answered. A
 * CONFIGURATION refusal, including the local self-containment one, is not in here:
 * it is thrown, before any request, exactly as every other command throws one.
 */
export type UploadAnswer =
	| {
			readonly deployed: true;
			readonly to: string;
			readonly indexer: string;
			readonly status: number;
			readonly arrival: string;
			readonly outcome: 'registered' | 'unchanged';
			readonly generation: UploadedGeneration;
			/** The node's own words, where it gave any (it does for `unchanged`). */
			readonly message?: string;
	  }
	| {
			readonly deployed: false;
			readonly to: string;
			readonly indexer: string;
			/** ABSENT where nothing answered at all. */
			readonly status?: number;
			/** The route's refusal code (`unauthorized`, `upload-failed`, `upload-too-large`, ...), where it named one. */
			readonly error?: string;
			readonly arrival?: string;
			readonly outcome?: string;
			/** Why, in the node's words where it gave any. */
			readonly reason: string;
	  };

/** What a test substitutes for the world; a deployment supplies none of it. */
export type UploadDependencies = {
	/** The environment flags fall back to. Defaults to `process.env`. */
	env?: EnvRecord;
	/** The HTTP client. Defaults to the runtime's own `fetch`. */
	fetch?: (input: string, init: RequestInit) => Promise<Response>;
	/** Working directory a relative bundle path resolves against. Defaults to `process.cwd()`. */
	cwd?: string;
};

/**
 * UPLOAD ONE BUNDLE and report what the node said.
 *
 * Throws on a configuration refusal and on the local self-containment refusal, both
 * before any request is made; resolves to an `UploadAnswer` for everything that
 * happened after the request was attempted, including a node that never answered.
 */
export async function upload(options: Options, deps: UploadDependencies = {}): Promise<UploadAnswer> {
	const env = deps.env ?? (process.env as EnvRecord);
	const config: UploadConfig = resolveCommandConfig('upload', options, env);
	// the ONE check, and the bytes it read: it resolves to nothing only for a
	// substituted arrival, which no caller of this command can make
	const bundle = (await refuseUnbundledProcessor(
		'upload',
		config.bundle,
		deps.cwd === undefined ? {} : {cwd: deps.cwd},
	)) as Uint8Array;
	return send(config, bundle, deps.fetch ?? ((input, init) => fetch(input, init)));
}

/** The route this command addresses: `/{indexer}/admin/upload` off the node's base URL. */
export function uploadRouteOf(to: string, indexer: string): string {
	return `${to.replace(/\/+$/, '')}/${encodeURIComponent(indexer)}/admin/upload`;
}

async function send(
	config: UploadConfig,
	bundle: Uint8Array,
	fetchImpl: NonNullable<UploadDependencies['fetch']>,
): Promise<UploadAnswer> {
	const {to, indexer} = config;
	const route = uploadRouteOf(to, indexer);
	// the content type is the ROUTE's constant rather than a copy of it. Imported
	// lazily, as `run` and `serve` import the server, so the commands that never send
	// do not pay for its dependency tree
	const {UPLOAD_CONTENT_TYPE} = await import('@etherfold/server');
	let res: Response;
	try {
		res = await fetchImpl(route, {
			method: 'POST',
			headers: {'Content-Type': UPLOAD_CONTENT_TYPE, Authorization: `Bearer ${config.adminToken}`},
			// copied into an ArrayBuffer-backed view, which is what `BodyInit` takes
			body: new Uint8Array(bundle),
		});
	} catch (err) {
		const cause = (err as {cause?: unknown})?.cause;
		const why = [err instanceof Error ? err.message : String(err), cause instanceof Error ? cause.message : undefined]
			.filter((part) => part !== undefined && part !== '')
			.join(': ');
		return {
			deployed: false,
			to,
			indexer,
			reason:
				`could not reach ${to} (${why}), so nothing was uploaded and nothing was deployed. Is the node running, ` +
				`and is --to (UPLOAD_TO) its base URL?`,
		};
	}

	const text = await res.text();
	let body: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		body = undefined;
	}
	const field = (name: string): string | undefined => {
		const value = body?.[name];
		return typeof value === 'string' ? value : undefined;
	};

	if (res.status === 200 && body?.success === true) {
		const outcome = field('outcome');
		const generation = generationIn(body.generation);
		if ((outcome === 'registered' || outcome === 'unchanged') && generation) {
			const message = field('message');
			return {
				deployed: true,
				to,
				indexer,
				status: res.status,
				arrival: field('arrival') ?? 'upload',
				outcome,
				generation,
				...(message === undefined ? {} : {message}),
			};
		}
	}

	const error = field('error');
	const arrival = field('arrival');
	const outcome = field('outcome');
	return {
		deployed: false,
		to,
		indexer,
		status: res.status,
		...(error === undefined ? {} : {error}),
		...(arrival === undefined ? {} : {arrival}),
		...(outcome === undefined ? {} : {outcome}),
		reason:
			field('message') ??
			(body === undefined
				? `the node answered ${res.status} with no upload report${text.trim() === '' ? '' : `: ${text.trim().slice(0, 500)}`}`
				: `the node answered ${res.status} without a registration: ${JSON.stringify(body).slice(0, 500)}`),
	};
}

function generationIn(value: unknown): UploadedGeneration | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const {stream, processor, digest} = value as Record<string, unknown>;
	if (typeof stream !== 'string' || typeof processor !== 'string' || typeof digest !== 'string') return undefined;
	return {stream, processor, digest};
}

/**
 * THE ANSWER IN WORDS, one `key: value` per line so a CI log can be grepped: which
 * outcome, which generation and which arrival for a deploy; the status, the node's
 * refusal code and its reason for anything else.
 */
export function describeUpload(answer: UploadAnswer): string[] {
	const where = `indexer: ${answer.indexer} at ${answer.to}`;
	if (answer.deployed) {
		const headline =
			answer.outcome === 'registered'
				? `etherfold upload: REGISTERED. The node indexes this generation: if another answers its reads it ` +
					`catches up beside it and the node's promotion policy moves the pointer once it has, and if none ` +
					`does yet (a first upload) it answers them as soon as it has folded.`
				: `etherfold upload: UNCHANGED. The node already folds these bytes, so nothing was registered.`;
		return [
			headline,
			`outcome: ${answer.outcome}`,
			`arrival: ${answer.arrival}`,
			`generation: ${answer.generation.digest}`,
			`  stream: ${answer.generation.stream}`,
			`  processor: ${answer.generation.processor}`,
			where,
			...(answer.message === undefined ? [] : [`message: ${answer.message}`]),
		];
	}
	return [
		answer.status === undefined
			? `etherfold upload: FAILED. Nothing answered, so nothing was deployed.`
			: `etherfold upload: FAILED. The node answered ${answer.status}${answer.error ? ` ${answer.error}` : ''}, ` +
				`so nothing was deployed.`,
		`outcome: ${answer.outcome ?? 'failed'}`,
		...(answer.arrival === undefined ? [] : [`arrival: ${answer.arrival}`]),
		...(answer.status === undefined ? [] : [`status: ${answer.status}`]),
		...(answer.error === undefined ? [] : [`error: ${answer.error}`]),
		where,
		`reason: ${answer.reason}`,
	];
}

/**
 * THE PROCESS: upload, print, and resolve the exit code a pipeline reads.
 *
 * `0` on `registered` and `unchanged`, `1` on everything else (see the header).
 * The outcome of a deploy goes to stdout and every failure to stderr, so a
 * pipeline that captures one stream still sees what it needs.
 */
export async function uploadMain(
	options: Options,
	deps: UploadDependencies & {
		exit?: (code: number) => void;
		log?: (...args: unknown[]) => void;
		error?: (...args: unknown[]) => void;
	} = {},
): Promise<void> {
	const exit = deps.exit ?? ((code: number) => process.exit(code));
	const log = deps.log ?? console.log;
	const error = deps.error ?? console.error;

	let answer: UploadAnswer;
	try {
		answer = await upload(options, deps);
	} catch (err) {
		// a configuration refusal or the local self-containment one: printed as the
		// message it is, since each names the flag, the file or the command to run
		error(err instanceof Error ? err.message : err);
		exit(1);
		return;
	}
	const lines = describeUpload(answer);
	if (answer.deployed) {
		for (const line of lines) log(line);
		exit(0);
	} else {
		for (const line of lines) error(line);
		exit(1);
	}
}

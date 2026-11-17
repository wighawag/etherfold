import type {RegistrationVerifier} from '../../src/index.js';

/**
 * A TEST verifier standing where S1-3's shared ownership proof will (step S2b):
 * a proof is `{address, signature}`, valid when the signature is
 * `signed:<address>:<path>`, so a proof for one route does not pass at another.
 */
export const testVerifier: RegistrationVerifier = {
	async verify({path, body}) {
		const proof = body['proof'] as {address?: unknown; signature?: unknown} | undefined;
		if (typeof proof?.address !== 'string') return {ok: false, reason: 'no proof'};
		if (proof.signature !== `signed:${proof.address}:${path}`) return {ok: false, reason: 'bad signature'};
		return {ok: true, address: proof.address};
	},
};

export function proofFor(address: string, path: string) {
	return {address, signature: `signed:${address}:${path}`};
}

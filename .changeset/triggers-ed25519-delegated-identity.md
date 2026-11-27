---
'@etherfold/triggers': minor
'@etherfold/platform-nodejs-triggers': patch
---

`delegatedIdentityVerifier` takes delegated-identity 0.2's proof, the one push-notification-server 0.3's `/register` checks. A registration's body now carries the account's public key set beside `address`, `domain` and `ownershipSignature`: `keySet: {signing: {publicKey}, encryption: {publicKey}}` (an Ed25519 signing key and an X25519 encryption key, 0x hex), which the wallet's ownership signature authorizes for the app's origin, and the `SIGNATURE` header is the signing key's Ed25519 signature over the request, naming its key (`<timestamp>:<key>:<signature>`). The same client body registers at push-notification-server and at the trigger service. The old proof (a secp256k1 delegate key, a recovered request signature) is refused, with no compatibility. A signed request is still accepted once, now named by the SHA-256 of the envelope the signing key signed. The Node.js triggers platform's tests and README follow the new wire.

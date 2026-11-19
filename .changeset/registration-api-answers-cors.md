---
'@etherfold/triggers': minor
'@etherfold/platform-nodejs-triggers': patch
---

The registration API answers CORS for the app its verifier serves, so a browser app on its own origin registers its triggers directly. A preflight (`OPTIONS`) from that origin is answered `204` with `Access-Control-Allow-Origin` set to it, `Access-Control-Allow-Methods: POST,OPTIONS`, `Access-Control-Allow-Headers: content-type,signature`, an `Access-Control-Max-Age` and `Vary: Origin`; every other response, refusals included, carries the same allow-origin and `Vary`, so the app can read a refusal's reason. Another origin gets no allow-origin, never `*`, and no credentials are allowed; the proof checks, `serverOrigin` and the signed path are unchanged.

- `@etherfold/triggers`: `RegistrationVerifier` takes an optional `appOrigin`, the origin `createRegistrationAPI` answers CORS for (none when absent). `delegatedIdentityVerifier` sets it to its `domain`'s origin, the one app it serves.
- `@etherfold/triggers`: an unexpected failure inside a registration route is answered as a JSON `500 internal-error` (with the CORS headers, the cause logged and not sent) instead of being rethrown to the server, whose bare 500 a browser could not read.
- `@etherfold/platform-nodejs-triggers`: `etherfold-triggers run` serves it with no change to a config that names a verifier.

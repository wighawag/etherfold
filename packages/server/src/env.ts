export type Env = {
	DEV?: string;
	/**
	 * The shared secret a log-fetcher presents as `Authorization: Bearer <token>`
	 * to reach `/ingest`.
	 *
	 * OPTIONAL in the type and REQUIRED in effect: with no token configured the
	 * server can authenticate nobody, so every ingestion call is refused with 401.
	 * That is the fail-closed direction on purpose. The retired server generated a
	 * key at boot and printed it to stdout, which is a server whose security is a
	 * line in a log file, and it is not repeated here.
	 */
	INGEST_TOKEN?: string;
	/**
	 * The secret an OPERATOR presents to reach `/{indexer}/admin/*`, where the
	 * canonical pointer is moved -- forwards to promote, BACK to revert.
	 *
	 * Optional in the type and required in effect, and fail-closed exactly as
	 * `INGEST_TOKEN` is: a server with none configured refuses every admin caller
	 * rather than letting everyone in. A deployment that never moves a pointer by
	 * hand simply never sets it, and that route then does nothing for anybody.
	 *
	 * **It is deliberately a SECOND credential and never the ingest one.** That one
	 * is handed to a log shipper and guards the WRITE path; letting it also decide
	 * WHICH GENERATION ANSWERS READS would give a fetcher control-plane authority
	 * over the deployment it feeds. Two secrets is the cost, and it is the same
	 * separation the two surfaces already have in every other respect.
	 *
	 * It does NOT guard `POST /admin/setup`, which is unauthenticated and stays so
	 * here: that is idempotent DDL and plausibly a deliberate bootstrap choice, and
	 * retrofitting a credential onto it is a decision of its own rather than a
	 * side effect of introducing this one.
	 */
	ADMIN_TOKEN?: string;
};

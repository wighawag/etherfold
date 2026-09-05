-- FIXED tables only, and every one of them lives in the reserved `_` namespace.
--
-- Entity tables are NOT here and never will be: the versioned-row state store
-- creates them at runtime from whatever entities a processor declares, so its
-- DDL is dynamic by construction. See docs/design/historical-state-database.md
-- and the state-store-sqlite package. This file is the part of the schema the
-- SERVER owns and can therefore ship as static SQL.
--
-- ## Why every name here begins with `_`
--
-- Those entity tables are created as `CREATE TABLE IF NOT EXISTS "<entity>"`
-- against the SAME database handle this file's tables live in -- `buildProcessor`
-- hands one handle to both the store and the server in every combined shape --
-- so a table here whose name a processor could also declare is a SILENT
-- collision: `IF NOT EXISTS` makes the entity's DDL succeed against our table,
-- and the failure surfaces much later as a column error on a write, nowhere near
-- the declaration that caused it.
--
-- `@etherfold/state-store` already closes that by REFUSING an entity whose name
-- starts with `_` (`isReserved`, `entities.ts`), and the store's own fixed tables
-- already sit there as `_blocks` and `_cursor`. The server's are the same KIND of
-- thing, so they sit there too, and the collision becomes impossible by
-- construction rather than by a second refusal that would have to be told these
-- names. `packages/server/test/reservedNamespace.test.ts` scans this file and
-- fails if a table or index here ever forgets the prefix.
CREATE TABLE IF NOT EXISTS _meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- The version row lives HERE, in the SQL, rather than being written by the code
-- that applies it. Both application paths must produce the same database, and
-- one of them is not ours: wrangler's D1 migrations execute these files and
-- nothing else. When the version was recorded in TypeScript, a D1-migrated
-- database came up with the table present and no version row, and reported
-- itself unhealthy forever. Keep this row in step with SCHEMA_VERSION in
-- schema.ts; a test asserts they agree.
-- ---------------------------------------------------------------------------
-- THE EMISSION STREAM (ADR-0006)
-- ---------------------------------------------------------------------------
-- The append-only log of what this server was told and what it took back: one
-- row per emitted log, retractions INCLUDED, superseded rows FLAGGED rather
-- than deleted. Nothing is ever updated here except `alive`, and nothing is
-- ever deleted. The canonical view is then a cheap derived read
-- (`WHERE alive AND blockNumber <= gate` ordered by `(blockNumber, logIndex)`)
-- and the retraction-aware feed is the same rows in `seq` order.
--
-- It is in the FIXED schema and not dynamic DDL, unlike the entity tables,
-- because two application paths must produce the SAME database and one of them
-- is wrangler's D1 migration, which executes this file and nothing else.
--
-- ## The KEY: two discriminators, both on every row
--
-- `indexer` is the NAMED INDEXER (ADR-0036), the multi-tenancy unit. It is the
-- HOST's value, not the fold's: the route segment a batch was posted to on a
-- split deployment, and the name the operator gave a combined one, which is
-- what a host closes over when it supplies the appender (ADR-0052). `stream` is
-- WHICH stream those logs belong to, as `streamDigestOf` renders it: a wide
-- digest over the deduplicated per-entry stream hashes plus the stream config
-- hash.
--
-- `stream` is deliberately NOT the wire context's `{source, config}`. That is a
-- 32-bit whole-entry hash kept whole on purpose (ADR-0034) as an identity check
-- between the two halves of a deployment, and it fails as a KEY twice over: a
-- decode-only change (a regenerated ABI, an added view function, a renamed
-- non-indexed parameter) moves it while the fetch filter is untouched, which
-- would orphan every row already stored; and 32 bits collide, which here means
-- one indexer silently adopting another's logs.
--
-- ## What is NOT a column, and never will be
--
-- Nothing about the PROCESSOR, and no GENERATION. The stream is keyed on
-- `{source, config}` and only the STATE on `{source, config, processor}`, so a
-- processor-only change is a new generation over the SAME stream. A column
-- carrying the processor would FORK this whole history on a processor change --
-- precisely the case the generation model promises is free.
--
-- `chainId` is not one either: it is already inside `stream`, via the block-0
-- skeleton entry that hashes the chain id, the genesis hash and each contract's
-- address and start block.
--
-- ## The raw log, and only the raw log
--
-- `address`, `topic0..topic3`, `data` and the block/transaction coordinates are
-- what the NODE said. The decoded `args` are what SOME ABI made of those bytes
-- and are re-derived on replay against the source running now, so persisting
-- them would persist an opinion that a decode-only change invalidates.
CREATE TABLE IF NOT EXISTS _emissions (
    -- the NAMED INDEXER the host folds under: the tenancy discriminator
    indexer TEXT NOT NULL,
    -- WHICH stream, as `streamDigestOf` renders it (NOT the wire identity)
    stream TEXT NOT NULL,
    -- the position a feed cursor addresses, monotonic within (indexer, stream).
    -- HOLES IN IT ARE LEGAL by contract, so that enabling pair-compaction later
    -- cannot break a consumer that assumed contiguity.
    seq INTEGER NOT NULL,
    -- 1 when this row IS a retraction of an earlier emission
    removed INTEGER NOT NULL,
    -- 1 while this emission is canonical. A retraction is never alive itself, and
    -- it sets the row it retracts to 0. This flag is the whole reason the
    -- canonical view is a read rather than a second table.
    alive INTEGER NOT NULL,
    blockNumber INTEGER NOT NULL,
    blockHash TEXT NOT NULL,
    logIndex INTEGER NOT NULL,
    transactionHash TEXT NOT NULL,
    transactionIndex INTEGER NOT NULL,
    -- present only when the node put it on the log; not every node does
    blockTimestamp INTEGER,
    address TEXT NOT NULL,
    -- NULL on an anonymous event, which carries no topic0 at all
    topic0 TEXT,
    topic1 TEXT,
    topic2 TEXT,
    topic3 TEXT,
    data TEXT NOT NULL,
    PRIMARY KEY (indexer, stream, seq)
);

-- THE CANONICAL VIEW's index, and the reason a flag beats a second table: it
-- covers only the live rows, so the retractions and the rows they killed cost
-- nothing to skip.
CREATE INDEX IF NOT EXISTS _emissions_canonical
    ON _emissions (indexer, stream, blockNumber, logIndex)
    WHERE alive = 1;

-- THE LOG API's index, whose shape is decided by `work/specs/proposed/node-log-api.md`
-- and honoured here rather than re-derived. ONE index and not five:
-- `topic1..topic3` are stored and left UNINDEXED, filtered after the range
-- scan, because indexing all four roughly doubles this table's index footprint
-- against D1's 10GB ceiling for little practical gain.
--
-- It leads with the two discriminators for the reason they exist: a range scan
-- that could omit one would cross into another tenant's rows.
CREATE INDEX IF NOT EXISTS _emissions_by_address_topic
    ON _emissions (indexer, stream, address, topic0, blockNumber);

-- ---------------------------------------------------------------------------
-- THE GENERATION REGISTRY (ADR-0053)
-- ---------------------------------------------------------------------------
-- WHICH generations a named indexer holds, and WHICH ONE answers reads. A
-- generation is a stream plus a fold over it, identified by the stream digest
-- plus the processor's version hash; an indexer holds several, one is canonical,
-- and reconfiguring builds a successor beside the live one and moves the pointer
-- when it is ready -- which is why a reconfigure is not an outage, and why
-- moving the pointer BACK is a revert that re-indexes nothing.
--
-- They are ROWS because a server or a CLI must come back up holding what it
-- held: the superseded generation it kept is the thing the pointer moves back
-- to, and a read tier has to resolve the pointer before it can even name a state
-- table (ADR-0053). This is what ADR-0008's `current_version` row becomes,
-- superseded in its KEY (the processor hash alone cannot express a filter
-- change) and in its RETENTION (dropping the old namespace is what made a revert
-- impossible), never in its mechanism.
--
-- The `indexer` column is the same discriminator `_emissions` carries and is
-- redundant for the same reason: ADR-0053 gives each named indexer a database of
-- its own. It is kept because it stays correct, costs little, and is what a
-- colocated deployment would need.
--
-- ## What is NOT here
--
-- The CAPS. `maxGenerations` and `maxStreams` are a CONFIGURED argument of
-- `openGenerationRegistry`, applied to what these rows say; a cap column would
-- fork a model this schema merely stores the inputs of. Nor is anything about
-- where a generation's STATE lives: that is a table-name namespace the state
-- store owns (ADR-0053), and dropping one is a port operation the host supplies.
CREATE TABLE IF NOT EXISTS _generations (
    -- the NAMED INDEXER these generations belong to: the tenancy discriminator
    indexer TEXT NOT NULL,
    -- WHICH stream, as `streamDigestOf` renders it
    stream TEXT NOT NULL,
    -- the processor's version hash, as `getVersionHash()` returns it
    processor TEXT NOT NULL,
    -- ms since the epoch, for ORDERING only and never identity: it is what puts
    -- "the previous generation" in a defined place in a listing an operator
    -- reads, and what makes the WRITER of a stream (the oldest surviving
    -- generation on it) a question these rows can answer
    createdAt INTEGER NOT NULL,
    -- the identity IS the key: two fields, compared element by element, never
    -- one delimited string in which one component could be read as another
    PRIMARY KEY (indexer, stream, processor)
);

-- THE CANONICAL POINTER: one small row per named indexer, and the whole of
-- promotion. Moving it forwards is promotion, moving it backwards is revert.
--
-- `stream` and `processor` are NULLABLE because a pointer that has never been
-- set is a real state (an indexer holding no generation yet), and they are only
-- ever written together.
--
-- `revision` is the CONCURRENCY GUARD every registry commit is conditional on
-- (ADR-0054). `RemoteSQL` is `prepare` + `batch` and nothing else, so a
-- transaction cannot stay open across the decision a commit makes: instead each
-- commit reads this value, guards every statement it writes on it, swaps it for
-- a fresh unique token in the same batch, and reads it back to learn whether it
-- won. A loser's statements applied to nothing and it retries. It lives on THIS
-- row rather than on one of its own because every commit already writes here.
CREATE TABLE IF NOT EXISTS _generation_pointer (
    indexer TEXT PRIMARY KEY,
    stream TEXT,
    processor TEXT,
    revision TEXT NOT NULL
);

INSERT INTO _meta (key, value) VALUES ('schemaVersion', '3')
    ON CONFLICT (key) DO UPDATE SET value = excluded.value;

import { readFileSync } from 'node:fs';
import pg from 'pg';
import pgvector from 'pgvector';
import { EMBED_DIM, VERIFY_MODE } from './config.ts';

// bigint (oid 20) already arrives as a string; dates must too, or pg would
// build a local-midnight Date out of a calendar day.
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool | pg.PoolClient;

export type ConnectionOptions = { connectionString?: string | undefined; pool?: pg.Pool | undefined };

// One writer at a time for the steps that decide whether two documents are the
// same event; everything slow (LLM calls) happens outside it.
const WRITE_LOCK = 724_100;

// One database. Every function in the library takes one of these, so a caller
// can hold several (hindsight-db, tests) or hand in a pool it already owns.
export class Connection {
  readonly pool: pg.Pool;

  constructor(opts: ConnectionOptions = {}) {
    this.pool = opts.pool ?? new pg.Pool({ connectionString: opts.connectionString ?? process.env.DATABASE_URL });
  }

  async withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  locked<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.withTransaction(async (client) => {
      await client.query('select pg_advisory_xact_lock($1)', [WRITE_LOCK]);
      return fn(client);
    });
  }

  // schema.sql is written with "if not exists" throughout, so init is safe to
  // re-run and is the place future migrations append to.
  async init(): Promise<void> {
    const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
    await this.pool.query(sql.replaceAll('EMBED_DIM', String(EMBED_DIM)));
  }

  end(): Promise<void> {
    return this.pool.end();
  }
}

export const vec = (v: number[]): string => pgvector.toSql(v) as string;

// The derived definitions from section 4, as SQL fragments over a claims alias.
export const hiddenClaim = (c: string): string =>
  VERIFY_MODE === 'strict' ? `${c}.verdict is not null` : `${c}.verdict is not distinct from 'refuted'`;
export const liveClaim = (c: string): string =>
  `${c}.kind = 'fact' and ${c}.superseded_by is null and not (${hiddenClaim(c)})`;
export const documentDate = (d: string): string => `coalesce(${d}.published_at, ${d}.ingested_at)`;

// When an event became known: its earliest document. Events are only ever
// created from a document, so the fallback to the event date never fires.
export const observedAt = (e: string): string =>
  `coalesce((select min(${documentDate('d')}) from documents d where d.event_id = ${e}.id), ${e}.occurred_at::timestamp at time zone 'utc')`;

// A claim's superseded_by as it stood at `asOf` (a timestamptz parameter, null
// for now): unset until the superseding claim itself had been asserted.
export const supersededAsOf = (c: string, asOf: string): string =>
  `case when ${asOf}::timestamptz is null then ${c}.superseded_by
        else (select s.id from claims s where s.id = ${c}.superseded_by and s.asserted_at <= ${asOf}::timestamptz) end`;

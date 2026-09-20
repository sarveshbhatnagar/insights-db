import { readFileSync } from 'node:fs';
import pg from 'pg';
import pgvector from 'pgvector';
import { EMBED_DIM, VERIFY_MODE } from './config.ts';

// bigint (oid 20) already arrives as a string; dates must too, or pg would
// build a local-midnight Date out of a calendar day.
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export type Db = pg.Pool | pg.PoolClient;

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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

export async function applySchema(): Promise<void> {
  const sql = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql.replaceAll('EMBED_DIM', String(EMBED_DIM)));
}

export const vec = (v: number[]): string => pgvector.toSql(v) as string;

// The derived definitions from section 4, as SQL fragments over a claims alias.
export const hiddenClaim = (c: string): string =>
  VERIFY_MODE === 'strict' ? `${c}.verdict is not null` : `${c}.verdict is not distinct from 'refuted'`;
export const liveClaim = (c: string): string =>
  `${c}.kind = 'fact' and ${c}.superseded_by is null and not (${hiddenClaim(c)})`;
export const documentDate = (d: string): string => `coalesce(${d}.published_at, ${d}.ingested_at)`;

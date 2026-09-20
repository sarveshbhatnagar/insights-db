import { afterEach, beforeEach } from 'vitest';
import { applySchema, pool } from '../src/db.ts';
import { fake } from './fake.ts';

export async function resetDb(): Promise<void> {
  await pool.query('drop schema public cascade; create schema public;');
  await applySchema();
}

export function freshDb(): void {
  beforeEach(async () => {
    fake.reset();
    await resetDb();
  });
  // A failed ingest hides its cause in documents.error; surface it when a test fails.
  afterEach(async (ctx) => {
    if (ctx.task.result?.state !== 'fail') return;
    const errors = await q<{ id: string; error: string }>('select id, error from documents where error is not null');
    if (errors.length) console.error('documents.error:', errors);
  });
}

export const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  pool.query<T>(sql, params).then((r) => r.rows);

export { fake };

import { beforeEach } from 'vitest';
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
}

export const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  pool.query<T>(sql, params).then((r) => r.rows);

export { fake };

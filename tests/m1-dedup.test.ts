import { describe, expect, it } from 'vitest';
import { normalize } from '../src/dedup.ts';
import { ingest } from '../src/index.ts';
import { bankArticle, bankExtraction } from './fixtures/index.ts';
import { fake, freshDb, q } from './helpers.ts';

freshDb();

const llmCalls = () => fake.calls.length;

describe('milestone 1: schema, document insert, dedup gate', () => {
  it('applies the schema to an empty database', async () => {
    const tables = await q<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'claims', 'documents', 'entities', 'event_entities', 'events', 'guidance', 'links', 'storylines',
    ]);
  });

  it('stores an exact repeat as a duplicate with zero LLM calls', async () => {
    fake.reply('extract', bankExtraction);
    const first = await ingest(bankArticle);
    expect(first.outcome).toBe('new');
    const before = llmCalls();
    const second = await ingest(bankArticle);
    expect(second.outcome).toBe('duplicate');
    expect(second.eventId).toBe(first.eventId);
    expect(llmCalls()).toBe(before);
    const docs = await q<{ id: string; duplicate_of: string | null; event_id: string | null }>(
      'select id, duplicate_of, event_id from documents order by id',
    );
    expect(docs).toHaveLength(2);
    expect(docs[1]!.duplicate_of).toBe(docs[0]!.id);
    expect(docs[1]!.event_id).toBe(first.eventId);
  });

  it('catches a copy with a changed headline and whitespace as a near duplicate', async () => {
    fake.reply('extract', bankExtraction);
    const first = await ingest(bankArticle);
    const before = llmCalls();
    const copy = await ingest({
      ...bankArticle,
      title: 'Ohio regulators shut Meridian Bank',
      body: bankArticle.body.replace(/\. /g, '.\n\n  ').replace(/ /g, '  '),
      publishedAt: '2026-09-12T14:30:00Z',
      source: 'Wire Two',
    });
    expect(copy.outcome).toBe('duplicate');
    expect(copy.eventId).toBe(first.eventId);
    expect(llmCalls()).toBe(before);
  });

  it('stores a body-only document with its ingest time as the document date', async () => {
    fake.reply('extract', bankExtraction);
    const result = await ingest({ body: bankArticle.body });
    expect(result.outcome).toBe('new');
    const [doc] = await q<{ title: string | null; published_at: Date | null; same: boolean }>(
      'select title, published_at, coalesce(published_at, ingested_at) = ingested_at as same from documents',
    );
    expect(doc!.title).toBeNull();
    expect(doc!.published_at).toBeNull();
    expect(doc!.same).toBe(true);
  });

  it('rejects an empty body and an unparseable publishedAt before storing anything', async () => {
    await expect(ingest({ body: '   ' })).rejects.toThrow(/body/);
    await expect(ingest({ body: 'text', publishedAt: 'last Tuesday' })).rejects.toThrow(/publishedAt/);
    expect(await q('select id from documents')).toHaveLength(0);
  });

  it('stores offset and UTC forms of the same instant identically', async () => {
    fake.reply('extract', bankExtraction, bankExtraction);
    await ingest({ body: 'first body of text', publishedAt: '2026-09-19T10:00:00+02:00' });
    await ingest({ body: 'second body of text', publishedAt: '2026-09-19T08:00:00Z' });
    const rows = await q<{ published_at: Date }>('select published_at from documents order by id');
    expect(rows[0]!.published_at.getTime()).toBe(rows[1]!.published_at.getTime());
    expect(rows[0]!.published_at.toISOString()).toBe('2026-09-19T08:00:00.000Z');
  });

  it('reads a naive timestamp as UTC', async () => {
    fake.reply('extract', bankExtraction);
    await ingest({ body: 'naive body of text', publishedAt: '2026-09-19T08:00:00' });
    const [row] = await q<{ published_at: Date }>('select published_at from documents');
    expect(row!.published_at.toISOString()).toBe('2026-09-19T08:00:00.000Z');
  });

  it('normalizes case, punctuation and whitespace', () => {
    expect(normalize('  Hello,   WORLD!  ')).toBe('hello world');
  });
});

import { describe, expect, it } from 'vitest';
import { getEvent, openInsights } from '../src/index.ts';
import * as f from './fixtures/index.ts';
import { db, fake, freshDb, q } from './helpers.ts';

freshDb();

const texts = (claims: { text: string }[]) => claims.map((c) => c.text);
const ids = (events: { id: string }[]) => events.map((e) => e.id);
const entityId = async (name: string) => (await q<{ id: string }>('select id from entities where name = $1', [name]))[0]!.id;

// Five events, oldest first, then two more documents on the bank failure: one
// that supersedes its withdrawal figure, and a different event about the same
// bank. No alias for FDIC, so entity resolution never asks the model.
async function seed() {
  fake.reply('extract', f.harborExtraction);
  const harbor = await db.ingest(f.harborArticle);
  fake.reply('extract', f.quakeExtraction1);
  fake.reply('link', f.noLinks);
  const quake = await db.ingest(f.quakeArticle1);
  fake.reply('extract', f.rateExtraction);
  fake.reply('link', f.noLinks);
  const rate = await db.ingest(f.rateArticle);
  fake.reply('extract', f.mortgageExtraction);
  fake.reply('link', f.noLinks);
  const mortgage = await db.ingest(f.mortgageArticle);
  fake.reply('extract', f.bankExtraction);
  fake.reply('link', f.noLinks);
  const bank = await db.ingest(f.bankArticle);
  const superseded = (await q<{ id: string }>('select id from claims where text = $1', [f.bankExtraction.claims[1]]))[0]!.id;
  fake.reply('extract', f.bankExtraction5);
  fake.reply('consolidate', { event_id: `E${bank.eventId}`, claims: [{ n: 'N1', supersedes: `C${superseded}`, conflicts_with: null }, { n: 'N2', supersedes: null, conflicts_with: null }] });
  fake.reply('link', f.noLinks);
  const update = await db.ingest(f.bankArticle5);
  expect(update).toMatchObject({ eventId: bank.eventId, outcome: 'merged', newClaims: 2 });
  fake.reply('extract', f.saleExtraction);
  fake.reply('consolidate', { event_id: null, claims: [] });
  fake.reply('link', f.noLinks);
  const sale = await db.ingest(f.saleArticle);
  for (const r of [harbor, quake, rate, mortgage, bank, sale]) expect(r.outcome).toBe('new');
  fake.calls.length = 0;
  return { harbor: harbor.eventId!, quake: quake.eventId!, rate: rate.eventId!, mortgage: mortgage.eventId!, bank: bank.eventId!, sale: sale.eventId!, superseded };
}

describe('events read API', () => {
  it('getMany returns found events in the order asked, as records with no LLM call', async () => {
    const { rate, mortgage } = await seed();
    const events = await db.events.getMany([mortgage, '999999', rate]);
    expect(ids(events)).toEqual([mortgage, rate]);
    expect(events[1]).toMatchObject({
      id: rate, occurredAt: '2026-08-01', eventType: 'rate_decision', title: f.rateExtraction.title,
      pattern: f.rateExtraction.pattern, storylineId: null,
    });
    expect(events[1]!.observedAt.toISOString()).toBe('2026-08-01T18:00:00.000Z');
    expect(events[1]!.entities.map((n) => [n.name, n.type, n.role])).toEqual([['Federal Reserve', 'org', 'decision maker'], ['Elena Ruiz', 'person', 'chair']]);
    expect(texts(events[1]!.claims)).toEqual(f.rateExtraction.claims);
    expect(events[1]!.claims[0]).toMatchObject({ kind: 'fact', supersededBy: null, hidden: false, disputedWith: [] });
    expect(await db.events.getMany([])).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });

  it('derives observedAt from the earliest document, or the ingest time without a date', async () => {
    const { bank } = await seed();
    const [event] = await db.events.getMany([bank]);
    // Two documents: 2026-09-11T08:00Z and 2026-09-13T10:00Z.
    expect(event!.observedAt.toISOString()).toBe('2026-09-11T08:00:00.000Z');

    fake.reply('extract', f.quakeExtraction2);
    fake.reply('link', f.noLinks);
    const undated = await db.ingest({ body: f.quakeArticle2.body });
    const [row] = await q<{ ingested_at: Date }>('select ingested_at from documents where id = $1', [undated.documentId]);
    const [event2] = await db.events.getMany([undated.eventId!]);
    expect(event2!.observedAt.getTime()).toBe(row!.ingested_at.getTime());
  });

  it('list pages by (occurredAt, id) in either direction', async () => {
    const { harbor, quake, rate, mortgage, bank, sale } = await seed();
    const first = await db.events.list({ limit: 2 });
    expect(ids(first.items)).toEqual([harbor, quake]);
    expect(first.nextCursor).toBeDefined();
    const second = await db.events.list({ limit: 2, cursor: first.nextCursor });
    expect(ids(second.items)).toEqual([rate, mortgage]);
    const third = await db.events.list({ limit: 2, cursor: second.nextCursor });
    expect(ids(third.items)).toEqual([bank, sale]);
    expect(third.nextCursor).toBeUndefined();

    const newest = await db.events.list({ order: 'desc', limit: 2 });
    expect(ids(newest.items)).toEqual([sale, bank]);
    expect(ids((await db.events.list({ order: 'desc', limit: 2, cursor: newest.nextCursor })).items)).toEqual([mortgage, rate]);
    expect(ids((await db.events.list()).items)).toEqual([harbor, quake, rate, mortgage, bank, sale]);
    await expect(db.events.list({ cursor: 'nope' })).rejects.toThrow(/cursor/);
  });

  it('list filters by type, entity, date range, asOf and excluded ids', async () => {
    const { harbor, quake, rate, mortgage, bank, sale } = await seed();
    const items = async (query: Parameters<typeof db.events.list>[0]) => ids((await db.events.list(query)).items);
    expect(await items({ eventType: 'bank_failure' })).toEqual([harbor, bank]);
    expect(await items({ eventType: ['earthquake', 'rate_decision'] })).toEqual([quake, rate]);
    expect(await items({ entityIds: [await entityId('Meridian Bank')] })).toEqual([bank, sale]);
    expect(await items({ entityIds: [await entityId('Meridian Bank')], eventType: 'bank_failure' })).toEqual([bank]);
    expect(await items({ from: '2026-08-01', to: '2026-08-31' })).toEqual([rate, mortgage]);
    expect(await items({ from: new Date('2026-08-02T00:00:00Z') })).toEqual([mortgage, bank, sale]);
    expect(await items({ excludeIds: [rate, bank] })).toEqual([harbor, quake, mortgage, sale]);
    // The bank failure was first reported at 2026-09-11T08:00Z.
    expect(await items({ asOf: '2026-09-11T07:59:59Z' })).toEqual([harbor, quake, rate, mortgage]);
    expect(await items({ asOf: new Date('2026-09-11T08:00:00Z') })).toEqual([harbor, quake, rate, mortgage, bank]);
  });

  it('list, similar and entities filter by storyline', async () => {
    // The bank failure and its sale in one storyline; an earthquake outside it.
    fake.reply('extract', f.bankExtraction);
    const bank = (await db.ingest(f.bankArticle)).eventId!;
    fake.reply('extract', f.saleExtraction);
    fake.reply('consolidate', { event_id: null, claims: [] });
    fake.reply('link', { continues: `E${bank}`, storyline_title: 'Meridian Bank collapse and aftermath',
      links: [{ src: 'E2', dst: `E${bank}`, type: 'reacts_to', reason: 'r' }] });
    const sale = (await db.ingest(f.saleArticle)).eventId!;
    fake.reply('extract', f.quakeExtraction1);
    fake.reply('link', f.noLinks);
    const quake = (await db.ingest(f.quakeArticle1)).eventId!;
    const [s] = await q<{ id: string }>('select id from storylines');
    const storylineId = s!.id;
    expect((await db.events.getMany([bank, quake])).map((e) => e.storylineId)).toEqual([storylineId, null]);

    const items = async (query: Parameters<typeof db.events.list>[0]) => ids((await db.events.list(query)).items);
    expect(await items({ storylineId })).toEqual([bank, sale]);
    expect(await items({ storylineId: [storylineId] })).toEqual([bank, sale]);
    expect(await items({ storylineId, eventType: 'bank_acquisition' })).toEqual([sale]);
    expect(await items({ storylineId: '999999' })).toEqual([]);
    expect(await items({})).toEqual([quake, bank, sale]);

    expect(ids(await db.events.similar({ eventId: bank, k: 5, filters: { storylineId } }))).toEqual([sale]);
    expect(ids(await db.events.similar({ eventId: quake, k: 5, filters: { storylineId } })).sort()).toEqual([bank, sale].sort());
    expect(await db.events.similar({ eventId: bank, k: 5, filters: { storylineId: '999999' } })).toEqual([]);

    // No alias for FDIC, so the two spellings stay separate entities.
    expect((await db.events.entities({ storylineId })).map((n) => [n.name, n.count]))
      .toEqual([['Meridian Bank', 2], ['Dana Whitfield', 1], ['FDIC', 1], ['Federal Deposit Insurance Corporation', 1], ['Northgate Bank', 1]]);
    expect(await db.events.entities({ storylineId: '999999' })).toEqual([]);
  });

  it('asOf hands out each event as it stood then: claims asserted by then, supersession not yet known', async () => {
    const { bank, superseded } = await seed();
    const now = (await db.events.getMany([bank]))[0]!;
    expect(texts(now.claims)).toEqual([...f.bankExtraction.claims.filter((_, i) => i !== 1), ...f.bankExtraction5.claims]);

    const then = (await db.events.getMany([bank], { asOf: '2026-09-12T00:00:00Z' }))[0]!;
    expect(texts(then.claims)).toEqual(f.bankExtraction.claims);
    expect(then.claims[1]).toMatchObject({ claimId: superseded, supersededBy: null });
    expect(then.observedAt).toEqual(now.observedAt);

    const detail = await getEvent(bank, { asOf: '2026-09-12T00:00:00Z' });
    expect(texts(detail.claims)).toEqual(f.bankExtraction.claims);
    expect(detail.documents).toHaveLength(1);
    expect(detail.observedAt.toISOString()).toBe('2026-09-11T08:00:00.000Z');
    expect((await getEvent(bank)).documents).toHaveLength(2);
    const history = await getEvent(bank, { includeHistory: true, asOf: '2026-09-14T00:00:00Z' });
    expect(history.claims.find((c) => c.claimId === superseded)!.supersededBy).not.toBeNull();
    // Before its first report the event did not exist.
    await expect(getEvent(bank, { asOf: '2026-09-11T00:00:00Z' })).rejects.toThrow(/no event/);
    expect(await db.events.getMany([bank], { asOf: '2026-09-11T00:00:00Z' })).toEqual([]);
  });

  it('similar ranks by the immutable pattern embedding by default, and by content on request', async () => {
    const { harbor, bank, sale } = await seed();
    const byPattern = await db.events.similar({ eventId: bank, k: 2 });
    expect(byPattern[0]!.id).toBe(harbor);
    expect(ids(byPattern)).not.toContain(bank);
    expect(byPattern[0]!.score).toBeGreaterThan(byPattern[1]!.score);
    expect(byPattern[0]!.pattern).toBe(f.harborExtraction.pattern);
    expect(texts(byPattern[0]!.claims)).toEqual(f.harborExtraction.claims);
    // Content is title plus live claims, so the event about the same bank wins there.
    const byContent = await db.events.similar({ eventId: bank, k: 2 }, 'content');
    expect(byContent[0]!.id).toBe(sale);

    expect(ids(await db.events.similar({ eventId: bank, k: 5, filters: { eventType: 'bank_failure' } }))).toEqual([harbor]);
    expect(ids(await db.events.similar({ eventId: bank, k: 5, filters: { excludeIds: [harbor] } }))).not.toContain(harbor);
    expect(await db.events.similar({ eventId: bank, k: 5, minScore: 0.999 })).toEqual([]);
    expect(ids(await db.events.similar({ eventId: bank, k: 5, filters: { asOf: '2026-09-01T00:00:00Z' } }))).not.toContain(sale);
    const byVector = await db.events.similar({ embedding: fake.embedding(f.harborExtraction.pattern), k: 1 });
    expect(ids(byVector)).toEqual([harbor]);
    expect(byVector[0]!.score).toBeCloseTo(1, 5);
    await expect(db.events.similar({ eventId: '999999' })).rejects.toThrow(/no event/);
    expect(fake.calls).toHaveLength(0);
  });

  it('types catalogs event types with counts and occurredAt span', async () => {
    await seed();
    expect(await db.events.types()).toEqual([
      { eventType: 'bank_failure', count: 2, from: '2026-06-12', to: '2026-09-10' },
      { eventType: 'bank_acquisition', count: 1, from: '2026-09-14', to: '2026-09-14' },
      { eventType: 'earthquake', count: 1, from: '2026-07-05', to: '2026-07-05' },
      { eventType: 'economic_data', count: 1, from: '2026-08-15', to: '2026-08-15' },
      { eventType: 'rate_decision', count: 1, from: '2026-08-01', to: '2026-08-01' },
    ]);
  });

  it('entities catalogs entities with counts and span, within the events asked', async () => {
    await seed();
    const all = await db.events.entities();
    // FDIC: harbor, the bank update, the sale. Meridian Bank: the failure and the sale.
    expect(all[0]).toMatchObject({ name: 'FDIC', type: 'org', count: 3, from: '2026-06-12', to: '2026-09-14' });
    expect(all[1]).toMatchObject({ name: 'Meridian Bank', type: 'org', count: 2, from: '2026-09-10', to: '2026-09-14' });
    expect(all.slice(2).every((n) => n.count === 1)).toBe(true);
    expect(await db.events.entities({ eventType: 'earthquake' })).toMatchObject([{ name: 'Chile', type: 'place', count: 1 }]);
    expect((await db.events.entities({ from: '2026-08-01', to: '2026-08-31' })).map((n) => n.name)).toEqual(['Elena Ruiz', 'Federal Reserve', 'Mortgage Lenders Council']);
    expect(await db.events.entities({ limit: 1 })).toHaveLength(1);
  });

  it('several handles can be open at once, over a shared pool or a connection string', async () => {
    const { bank } = await seed();
    const shared = openInsights({ pool: db.pool });
    const own = openInsights({ connectionString: process.env.DATABASE_URL });
    try {
      expect(ids(await shared.events.getMany([bank]))).toEqual([bank]);
      expect(ids(await own.events.getMany([bank]))).toEqual([bank]);
      expect(await own.events.types()).toEqual(await db.events.types());
    } finally {
      await own.end();
    }
    expect(ids(await shared.events.getMany([bank]))).toEqual([bank]);
  });
});

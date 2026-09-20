import { describe, expect, it } from 'vitest';
import { ask, getEvent, ingest, ingestMany, init, listClaims, listEntities, relink, retryFailed, searchEvents } from '../src/index.ts';
import * as f from './fixtures/index.ts';
import { db, fake, freshDb, q } from './helpers.ts';

freshDb();

const linkPrompts = () => fake.calls.filter((c) => c.step === 'link').map((c) => String(c.messages[1]!.content));

describe('init', () => {
  it('is idempotent', async () => {
    await init();
    await init();
    expect(await q('select id from events')).toEqual([]);
  });
});

describe('ingestMany', () => {
  it('folds concurrent reports of one event into one event, and dedups within the batch', async () => {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    fake.when('extract', f.bankArticle.title!, f.bankExtraction);
    fake.when('extract', f.bankArticle2.title!, f.bankExtraction2);
    fake.when('extract', f.bankArticle3.title!, f.bankExtraction3);
    fake.when('extract', f.quakeArticle1.title!, f.quakeExtraction1);
    // Whichever report wins the lock creates E1; the others merge into it, possibly asking twice.
    for (const title of [f.bankExtraction.title, f.bankExtraction2.title, f.bankExtraction3.title]) {
      fake.when('consolidate', `<new_event title="${title}"`, ...Array(4).fill({ event_id: 'E1', claims: [] }));
    }
    fake.when('resolve_entity', 'Name: FDIC', { match: 'T2' }, { match: 'T2' });
    fake.reply('link', ...Array(6).fill(f.noLinks));

    const docs = [f.bankArticle, f.bankArticle2, f.quakeArticle1, f.bankArticle3, { ...f.bankArticle, source: 'Copy Desk' }];
    const results = await ingestMany(docs, { concurrency: 4 });

    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'merged', 'merged', 'new', 'new']);
    const bank = results.filter((_, i) => i !== 2 && i !== 4);
    expect(new Set(bank.map((r) => r.eventId)).size).toBe(1);
    const dup = results[4]!;
    expect(dup.outcome).toBe('duplicate');
    expect(dup.eventId).toBe(bank[0]!.eventId);
    expect(dup.usage.calls).toBe(0);
    expect(results[2]!.eventId).not.toBe(bank[0]!.eventId);
    expect(await q('select id from events')).toHaveLength(2);
    expect((await getEvent(bank[0]!.eventId!)).documents).toHaveLength(4);
    const docRows = await q<{ event_id: string; duplicate_of: string | null }>('select event_id, duplicate_of from documents order by id');
    expect(docRows.every((d) => d.event_id !== null)).toBe(true);
    expect(results.filter((r) => r.outcome !== 'duplicate').every((r) => r.usage.calls > 0)).toBe(true);
  });

  it('rejects the whole batch before storing anything when a document is invalid', async () => {
    await expect(ingestMany([f.bankArticle, { body: ' ' }])).rejects.toThrow(/document 1: body/);
    await expect(ingestMany([{ body: 'x', publishedAt: 'yesterday' }])).rejects.toThrow(/document 0: unparseable/);
    expect(await q('select id from documents')).toHaveLength(0);
  });
});

describe('retryFailed', () => {
  it('re-runs a failed document in place', async () => {
    const failed = await ingest(f.rateArticle);
    expect(failed.outcome).toBe('failed');
    expect((await q<{ error: string }>('select error from documents'))[0]!.error).toMatch(/no reply queued/);

    fake.reply('extract', f.rateExtraction);
    const [retried] = await retryFailed();
    expect(retried).toMatchObject({ documentId: failed.documentId, outcome: 'new', newClaims: 3 });
    expect(await q('select id from documents')).toHaveLength(1);
    expect((await q<{ error: string | null }>('select error from documents'))[0]!.error).toBeNull();
    expect(await retryFailed()).toEqual([]);
  });

  it('re-runs only the link step for a document whose event was stored', async () => {
    fake.reply('extract', f.rateExtraction);
    const rate = await ingest(f.rateArticle);
    fake.reply('extract', f.mortgageExtraction);
    fake.reply('link', { continues: null, storyline_title: null, links: [{ src: 'E9', dst: 'E2', type: 'causes', reason: 'r' }] },
      { continues: null, storyline_title: null, links: [{ src: 'E9', dst: 'E2', type: 'causes', reason: 'r' }] });
    const mortgage = await ingest(f.mortgageArticle);
    expect(mortgage).toMatchObject({ outcome: 'new', newLinks: 0 });

    fake.reply('link', { continues: null, storyline_title: null, links: [{ src: `E${rate.eventId}`, dst: `E${mortgage.eventId}`, type: 'causes', reason: 'Higher rates cut applications' }] });
    const [retried] = await retryFailed();
    expect(retried).toMatchObject({ documentId: mortgage.documentId, eventId: mortgage.eventId, newLinks: 1 });
    expect(fake.calls.filter((c) => c.step === 'extract')).toHaveLength(2);
    expect(await q('select id from links')).toHaveLength(1);
    expect(await q('select id from documents where error is not null')).toHaveLength(0);
  });
});

describe('relink', () => {
  async function rateMortgageQuake() {
    fake.reply('extract', f.quakeExtraction1);
    const quake = await ingest(f.quakeArticle1);
    fake.reply('extract', f.rateExtraction);
    fake.reply('link', f.noLinks);
    const rate = await ingest(f.rateArticle);
    fake.reply('extract', f.mortgageExtraction);
    fake.reply('link', { continues: null, storyline_title: null, links: [{ src: `E${rate.eventId}`, dst: 'E3', type: 'causes', reason: 'Higher rates cut applications' }] });
    const mortgage = await ingest(f.mortgageArticle);
    expect(mortgage.newLinks).toBe(1);
    fake.calls.length = 0;
    return { quake: quake.eventId!, rate: rate.eventId!, mortgage: mortgage.eventId! };
  }

  it('re-judges an event that gained claims against events it is not yet connected to', async () => {
    const { quake, rate, mortgage } = await rateMortgageQuake();
    fake.reply('extract', { ...f.rateExtraction, claims: [...f.rateExtraction.claims, 'The vote was 10 to 2.'] });
    fake.reply('consolidate', { event_id: `E${rate}`, claims: [{ n: 'N4', supersedes: null, conflicts_with: null }] });
    fake.reply('link', { continues: null, storyline_title: null, links: [{ src: `E${quake}`, dst: `E${rate}`, type: 'background_for', reason: 'r' }] });
    const merged = await ingest({ ...f.rateArticle, body: `${f.rateArticle.body} The vote was 10 to 2.`, source: 'Capital Times' });
    expect(merged).toMatchObject({ eventId: rate, outcome: 'merged', newClaims: 1, newLinks: 1 });
    const [prompt] = linkPrompts();
    expect(prompt).toContain(`<new_event id="E${rate}"`);
    expect(prompt).toContain('The vote was 10 to 2.');
    expect(prompt).toContain(f.quakeExtraction1.title);
    expect(prompt).not.toContain(f.mortgageExtraction.title);
    expect(await q('select id from links')).toHaveLength(2);
    void mortgage;
  });

  it('makes no LLM call when every related event is already connected', async () => {
    const { quake, rate } = await rateMortgageQuake();
    await db.pool.query('insert into links (src, dst, type, reason) values ($1, $2, $3, $4)', [quake, rate, 'background_for', 'r']);
    expect(await relink(rate)).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('does not add a claim-free merge to the link budget', async () => {
    const { rate } = await rateMortgageQuake();
    fake.reply('extract', f.rateExtraction);
    fake.reply('consolidate', { event_id: `E${rate}`, claims: [] });
    const merged = await ingest({ ...f.rateArticle, source: 'Wire Two', body: `${f.rateArticle.body} Repeated.` });
    expect(merged).toMatchObject({ outcome: 'merged', newClaims: 0, newLinks: 0 });
    expect(linkPrompts()).toHaveLength(0);
  });
});

describe('search functions', () => {
  async function seed() {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    fake.reply('extract', f.bankExtraction);
    const bank = await ingest(f.bankArticle);
    fake.reply('extract', f.bankExtraction3);
    fake.reply('consolidate', { event_id: `E${bank.eventId}`, claims: [{ n: 'N1', supersedes: null, conflicts_with: null }, { n: 'N3', supersedes: null, conflicts_with: null }] });
    await ingest(f.bankArticle3);
    fake.reply('extract', f.quakeExtraction1);
    fake.reply('link', f.noLinks);
    const quake = await ingest(f.quakeArticle1);
    fake.calls.length = 0;
    return { bank: bank.eventId!, quake: quake.eventId! };
  }

  it('searchEvents ranks by hybrid score and honours date bounds', async () => {
    const { bank, quake } = await seed();
    const hits = await searchEvents('Meridian Bank deposit run');
    expect(hits[0]!.eventId).toBe(bank);
    expect(hits.map((h) => h.eventId)).toContain(quake);
    expect(await searchEvents('earthquake', { dateFrom: '2026-09-01' })).toEqual([{ eventId: bank, title: f.bankExtraction.title, occurredAt: '2026-09-10' }]);
  });

  it('listClaims finds speculation and filters by kind', async () => {
    const { bank } = await seed();
    const hype = await listClaims({ query: 'regional banks could fail', speculation: true });
    expect(hype).toHaveLength(1);
    expect(hype[0]).toMatchObject({ eventId: bank, kind: 'speculation', text: f.bankExtraction3.speculation[0], verdict: null, hidden: false });
    const facts = await listClaims({ query: 'Meridian Bank', speculation: false, k: 3 });
    expect(facts).toHaveLength(3);
    expect(facts.every((c) => c.kind === 'fact')).toBe(true);
    const all = await listClaims();
    // 5 bank facts + 1 fact and 1 speculation from the third article + 2 quake facts
    expect(all).toHaveLength(9);
    expect(all[0]!.assertedAt.getTime()).toBeGreaterThanOrEqual(all.at(-1)!.assertedAt.getTime());
  });

  it('listEntities matches names and aliases and counts events', async () => {
    await seed();
    const hits = await listEntities({ query: 'meridian' });
    expect(hits[0]).toMatchObject({ name: 'Meridian Bank', type: 'org', events: 1 });
    const orgs = await listEntities({ type: 'org' });
    expect(orgs.map((e) => e.name).sort()).toEqual(['Federal Deposit Insurance Corporation', 'Meridian Bank']);
    expect(await listEntities({ type: 'place' })).toMatchObject([{ name: 'Chile' }]);
  });

  it('search_claims lets the agent cite speculation it never opened an event for', async () => {
    await seed();
    fake.reply('query',
      { tool_calls: [{ name: 'search_claims', args: { query: 'banks could fail', speculation: true } }] },
      { answer: 'Harbor Research analysts said more regional banks could fail if rates stay high.', claim_ids: ['C{id}'] },
    );
    const [hype] = await listClaims({ speculation: true });
    fake.replies.set('query', fake.replies.get('query')!.map((r) => (typeof r === 'object' && 'answer' in r ? { ...r, claim_ids: [`C${hype!.claimId}`] } : r)));
    const { citations } = await ask('What hype is there about bank failures?');
    expect(citations.map((c) => c.claimId)).toEqual([hype!.claimId]);
    const result = JSON.parse(String(fake.calls[1]!.messages.at(-1)!.content)) as { claim_id: string; kind: string }[];
    expect(result).toEqual([{ claim_id: `C${hype!.claimId}`, event_id: expect.any(String), text: hype!.text, kind: 'speculation' }]);
  });
});

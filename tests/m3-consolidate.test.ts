import { describe, expect, it } from 'vitest';
import { detachDocument, getEvent, ingest } from '../src/index.ts';
import { renderEvent } from '../src/query.ts';
import * as f from './fixtures/index.ts';
import { db, fake, freshDb, q } from './helpers.ts';

freshDb();

const liveTexts = async (eventId: string) => (await getEvent(eventId)).claims.map((c) => c.text);
const claimId = async (text: string) => (await q<{ id: string }>('select id from claims where text = $1', [text]))[0]!.id;
const lastPrompt = () => String(fake.calls.at(-1)!.messages[1]!.content);

// Three outlets, one event. Returns the event id.
async function ingestThree(): Promise<string> {
  fake.reply('extract', f.bankExtraction);
  const first = await ingest(f.bankArticle);
  expect(first.outcome).toBe('new');
  expect(fake.calls.map((c) => c.step)).toEqual(['extract']);
  const eventId = first.eventId!;

  fake.reply('extract', f.bankExtraction2);
  fake.reply('resolve_entity', { match: `T${await entityId('Federal Deposit Insurance Corporation')}` });
  fake.reply('consolidate', { event_id: `E${eventId}`, claims: [{ n: 'N3', supersedes: null, conflicts_with: null }, { n: 'N4', supersedes: null, conflicts_with: null }] });
  const second = await ingest(f.bankArticle2);
  expect(second).toMatchObject({ eventId, outcome: 'merged', newClaims: 2, newLinks: 0 });

  fake.reply('extract', f.bankExtraction3);
  fake.reply('consolidate', { event_id: `E${eventId}`, claims: [{ n: 'N1', supersedes: null, conflicts_with: null }, { n: 'N3', supersedes: null, conflicts_with: null }] });
  const third = await ingest(f.bankArticle3);
  expect(third).toMatchObject({ eventId, outcome: 'merged', newClaims: 2 });
  return eventId;
}
const entityId = async (name: string) => (await q<{ id: string }>('select id from entities where name = $1', [name]))[0]!.id;

describe('milestone 3: consolidation and write', () => {
  it('folds three outlets into one event whose live claims are the distinct facts', async () => {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    const eventId = await ingestThree();
    expect(await q('select id from events')).toHaveLength(1);
    expect(await liveTexts(eventId)).toEqual(f.bankDistinctFacts);
    const event = await getEvent(eventId);
    expect(event.speculation.map((c) => c.text)).toEqual(f.bankExtraction3.speculation);
    expect(event.documents).toHaveLength(3);
    expect(await renderEvent(db, eventId)).toBe([f.bankExtraction.title, ...f.bankDistinctFacts.map((t) => `- ${t}`)].join('\n'));
    // The FDIC alias was merged in step 3 rather than creating a second entity.
    expect(await q("select id from entities where type = 'org'")).toHaveLength(2);
  });

  it('renders the consolidate prompt with prefixed ids and marks', async () => {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    const eventId = await ingestThree();
    const prompt = String(fake.calls.filter((c) => c.step === 'consolidate').at(-1)!.messages[1]!.content);
    expect(prompt).toContain(`<new_event title="${f.bankExtraction3.title}" type="bank_failure" occurred_at="2026-09-10"\n           document_date="2026-09-12" entities="Meridian Bank, Federal Deposit Insurance Corporation">`);
    expect(prompt).toContain(`N1. ${f.bankExtraction3.claims[0]}\nN2. ${f.bankExtraction3.claims[1]}\nN3. [speculation] ${f.bankExtraction3.speculation[0]}\n</new_event>`);
    expect(prompt).toContain(`<event id="E${eventId}" title="${f.bankExtraction.title}" type="bank_failure" occurred_at="2026-09-10" entities="Meridian Bank, Federal Deposit Insurance Corporation, Dana Whitfield">`);
    expect(prompt).toMatch(new RegExp(`C\\d+\\. \\(2026-09-11\\) ${f.bankExtraction.claims[0]!.replace(/[.]/g, '\\.')}`));
    expect(prompt).not.toMatch(/\{[a-z_]+\}/);
  });

  it('gives merged with zero new claims for a paraphrased fourth article', async () => {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    const eventId = await ingestThree();
    fake.reply('extract', f.bankExtraction4);
    fake.reply('consolidate', { event_id: `E${eventId}`, claims: [] });
    const fourth = await ingest(f.bankArticle4);
    expect(fourth).toMatchObject({ eventId, outcome: 'merged', newClaims: 0 });
    expect(await liveTexts(eventId)).toEqual(f.bankDistinctFacts);
    expect((await getEvent(eventId)).documents).toHaveLength(4);
  });

  it('supersedes the old figure and adds one claim for an updated count', async () => {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    const eventId = await ingestThree();
    const old = await claimId(f.bankExtraction.claims[1]!);
    fake.reply('extract', f.bankExtraction5);
    fake.reply('consolidate', { event_id: `E${eventId}`, claims: [{ n: 'N1', supersedes: `C${old}`, conflicts_with: null }, { n: 'N2', supersedes: null, conflicts_with: null }] });
    const fifth = await ingest(f.bankArticle5);
    expect(fifth).toMatchObject({ eventId, outcome: 'merged', newClaims: 2 });
    const live = await liveTexts(eventId);
    expect(live).not.toContain(f.bankExtraction.claims[1]);
    expect(live).toEqual(expect.arrayContaining(f.bankExtraction5.claims));
    expect(live).toHaveLength(f.bankDistinctFacts.length + 1);
    const [row] = await q<{ superseded_by: string; text: string }>(
      'select s.superseded_by, n.text from claims s join claims n on n.id = s.superseded_by where s.id = $1', [old]);
    expect(row!.text).toBe(f.bankExtraction5.claims[0]);
    const history = await getEvent(eventId, { includeHistory: true });
    expect(history.claims.find((c) => c.claimId === old)!.supersededBy).toBe(row!.superseded_by);
  });

  it('records conflicts_with on the new claim and reports both as disputed', async () => {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    const eventId = await ingestThree();
    const old = await claimId(f.bankExtraction.claims[1]!);
    fake.reply('extract', f.bankExtraction5);
    fake.reply('consolidate', { event_id: `E${eventId}`, claims: [{ n: 'N1', supersedes: null, conflicts_with: `C${old}` }] });
    await ingest(f.bankArticle5);
    const event = await getEvent(eventId);
    const a = event.claims.find((c) => c.claimId === old)!;
    const b = event.claims.find((c) => c.text === f.bankExtraction5.claims[0])!;
    expect(a.disputedWith).toEqual([b.claimId]);
    expect(b.disputedWith).toEqual([a.claimId]);
  });

  it('creates a new event for a different occurrence with the same entities', async () => {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    const eventId = await ingestThree();
    fake.reply('extract', f.saleExtraction);
    fake.reply('consolidate', { event_id: null, claims: [] });
    fake.reply('link', f.noLinks);
    const sale = await ingest(f.saleArticle);
    expect(sale.outcome).toBe('new');
    expect(sale.eventId).not.toBe(eventId);
    expect(sale.newClaims).toBe(3);
    expect(fake.calls.map((c) => c.step).slice(-3)).toEqual(['extract', 'consolidate', 'link']);
    expect(await liveTexts(sale.eventId!)).toEqual(f.saleExtraction.claims);
  });

  it('drops a re-added stored fact at the claim guard', async () => {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    const eventId = await ingestThree();
    fake.reply('extract', { ...f.bankExtraction4, claims: [f.bankExtraction.claims[0]!, 'Meridian Bank employed 1,200 people.'] });
    fake.reply('consolidate', { event_id: `E${eventId}`, claims: [{ n: 'N1', supersedes: null, conflicts_with: null }, { n: 'N2', supersedes: null, conflicts_with: null }] });
    const result = await ingest(f.bankArticle4);
    expect(result).toMatchObject({ outcome: 'merged', newClaims: 1 });
    expect(await liveTexts(eventId)).toEqual([...f.bankDistinctFacts, 'Meridian Bank employed 1,200 people.']);
  });

  it('rejects a consolidate reply that names an unknown id or claims with a null event', async () => {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    const eventId = await ingestThree();
    fake.reply('extract', f.bankExtraction4);
    fake.reply('consolidate', { event_id: 'E999', claims: [] }, { event_id: null, claims: [{ n: 'N1', supersedes: null, conflicts_with: null }] });
    const result = await ingest(f.bankArticle4);
    expect(result.outcome).toBe('failed');
    const [doc] = await q<{ error: string; event_id: string | null }>('select error, event_id from documents order by id desc limit 1');
    expect(doc!.error).toMatch(/consolidate: invalid reply/);
    expect(doc!.event_id).toBeNull();
    expect(await liveTexts(eventId)).toEqual(f.bankDistinctFacts);
    // A failed document is not a dedup original: re-ingesting it runs the pipeline again.
    fake.reply('extract', f.bankExtraction4);
    fake.reply('consolidate', { event_id: `E${eventId}`, claims: [] });
    expect((await ingest(f.bankArticle4)).outcome).toBe('merged');
  });

  it('detachDocument restores the prior state and re-ingests the document elsewhere', async () => {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    fake.reply('extract', f.bankExtraction);
    const first = await ingest(f.bankArticle);
    const eventId = first.eventId!;
    const before = await getEvent(eventId);
    const embeddingBefore = (await q<{ v: string }>('select content_embedding::text as v from events where id = $1', [eventId]))[0]!.v;

    // Wrong merge: the sale article folded into the failure event.
    fake.reply('extract', f.saleExtraction);
    fake.reply('resolve_entity', { match: `T${await entityId('Federal Deposit Insurance Corporation')}` });
    fake.reply('consolidate', { event_id: `E${eventId}`, claims: [{ n: 'N1', supersedes: null, conflicts_with: null }, { n: 'N2', supersedes: null, conflicts_with: null }] });
    const wrong = await ingest(f.saleArticle);
    expect(wrong).toMatchObject({ eventId, outcome: 'merged', newClaims: 2 });
    expect((await getEvent(eventId)).claims).toHaveLength(7);

    fake.reply('extract', f.saleExtraction);
    fake.reply('link', f.noLinks);
    const redo = await detachDocument(wrong.documentId);
    expect(redo.documentId).toBe(wrong.documentId);
    expect(redo.outcome).toBe('new');
    expect(redo.eventId).not.toBe(eventId);

    const after = await getEvent(eventId);
    expect(after.claims).toEqual(before.claims);
    expect(after.speculation).toEqual(before.speculation);
    expect(after.documents.map((d) => d.documentId)).toEqual([first.documentId]);
    const embeddingAfter = (await q<{ v: string }>('select content_embedding::text as v from events where id = $1', [eventId]))[0]!.v;
    expect(embeddingAfter).toBe(embeddingBefore);
    expect(await liveTexts(redo.eventId!)).toEqual(f.saleExtraction.claims);
    const consolidatePrompts = fake.calls.filter((c) => c.step === 'consolidate');
    expect(consolidatePrompts).toHaveLength(1);
  });
});

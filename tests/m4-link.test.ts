import { describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { ingest } from '../src/ingest.ts';
import { linkEvent } from '../src/link.ts';
import { getEvent, getStoryline } from '../src/query.ts';
import * as f from './fixtures/index.ts';
import { fake, freshDb, q } from './helpers.ts';

freshDb();

const links = () => q<{ src: string; dst: string; type: string; reason: string }>('select src, dst, type, reason from links order by id');
const linkPrompt = () => String(fake.calls.filter((c) => c.step === 'link').at(-1)!.messages[1]!.content);



describe('milestone 4: links', () => {
  it('links a rate rise to a later fall in mortgage applications with one causes link', async () => {
    fake.reply('extract', f.rateExtraction);
    const rate = await ingest(f.rateArticle);
    const rateId = rate.eventId!;
    fake.reply('extract', f.mortgageExtraction);
    // E2 is the id the new event will get in an empty database.
    fake.reply('link', { continues: null, storyline_title: null, links: [{ src: `E${rateId}`, dst: 'E2', type: 'causes', reason: 'Higher rates raised mortgage costs, cutting applications' }] });
    const mortgage = await ingest(f.mortgageArticle);
    expect(mortgage).toMatchObject({ outcome: 'new', newLinks: 1, eventId: '2' });
    expect(fake.calls.map((c) => c.step)).toEqual(['extract', 'extract', 'link']);
    expect(await links()).toEqual([{ src: rateId, dst: '2', type: 'causes', reason: 'Higher rates raised mortgage costs, cutting applications' }]);

    const prompt = linkPrompt();
    expect(prompt).toContain(`<new_event id="E2" title="${f.mortgageExtraction.title}" occurred_at="2026-08-15">\n${f.mortgageExtraction.claims.join('\n')}\n</new_event>`);
    expect(prompt).toContain(`<event id="E${rateId}" title="${f.rateExtraction.title}" occurred_at="2026-08-01"\n       storyline="none">\n${f.rateExtraction.claims.join('\n')}\n</event>`);
    expect(prompt).not.toMatch(/\{[a-z_]+\}/);

    const detail = await getEvent('2');
    expect(detail.links).toEqual([{ eventId: rateId, title: f.rateExtraction.title, type: 'causes', direction: 'in', reason: 'Higher rates raised mortgage costs, cutting applications' }]);
    expect((await getEvent(rateId)).links[0]!.direction).toBe('out');
  });

  it('gives two unrelated earthquakes no link and no storyline', async () => {
    fake.reply('extract', f.quakeExtraction1);
    const one = await ingest(f.quakeArticle1);
    fake.reply('extract', f.quakeExtraction2);
    fake.reply('link', f.noLinks);
    const two = await ingest(f.quakeArticle2);
    expect(two).toMatchObject({ outcome: 'new', newLinks: 0 });
    expect(await links()).toEqual([]);
    expect((await getEvent(one.eventId!)).storyline).toBeNull();
    expect((await getEvent(two.eventId!)).storyline).toBeNull();
    expect(await q('select id from storylines')).toHaveLength(0);
  });

  it('adds no rows when the step is re-run, and refuses a reverse duplicate', async () => {
    fake.reply('extract', f.rateExtraction);
    const rate = await ingest(f.rateArticle);
    const rateId = rate.eventId!;
    const link = { src: `E${rateId}`, dst: 'E2', type: 'causes', reason: 'Higher rates raised mortgage costs, cutting applications' };
    fake.reply('extract', f.mortgageExtraction);
    fake.reply('link', { continues: null, storyline_title: null, links: [link] });
    await ingest(f.mortgageArticle);

    fake.reply('link', { continues: null, storyline_title: null, links: [link] });
    expect(await linkEvent(pool, '2', [])).toBe(0);
    fake.reply('link', { continues: null, storyline_title: null, links: [{ ...link, src: 'E2', dst: `E${rateId}`, type: 'reacts_to' }] });
    expect(await linkEvent(pool, '2', [])).toBe(0);
    expect(await links()).toHaveLength(1);
    expect(await q('select id from storylines')).toHaveLength(0);
  });

  it('rejects a causes link that runs backwards in time, and accepts it once turned around', async () => {
    fake.reply('extract', f.rateExtraction);
    const rate = await ingest(f.rateArticle);
    fake.reply('extract', f.mortgageExtraction);
    fake.reply('link',
      { continues: null, storyline_title: null, links: [{ src: 'E2', dst: `E${rate.eventId}`, type: 'causes', reason: 'r' }] },
      { continues: null, storyline_title: null, links: [{ src: `E${rate.eventId}`, dst: 'E2', type: 'causes', reason: 'r' }] });
    expect(await ingest(f.mortgageArticle)).toMatchObject({ outcome: 'new', newLinks: 1 });
    expect(String(fake.calls.at(-1)!.messages.at(-1)!.content)).toMatch(/earlier event to the later one/);
    fake.reply('link',
      { continues: null, storyline_title: null, links: [{ src: `E${rate.eventId}`, dst: 'E2', type: 'reacts_to', reason: 'r' }] },
      { continues: null, storyline_title: null, links: [{ src: `E${rate.eventId}`, dst: 'E2', type: 'reacts_to', reason: 'r' }] });
    await expect(linkEvent(pool, '2', [])).rejects.toThrow(/invalid reply after retry/);
    expect(await links()).toHaveLength(1);
  });

  it('rejects a link that does not involve the new event, an unknown id, or a self link', async () => {
    fake.reply('extract', f.quakeExtraction1);
    await ingest(f.quakeArticle1);
    fake.reply('extract', f.rateExtraction);
    fake.reply('link', f.noLinks);
    expect((await ingest(f.rateArticle)).eventId).toBe('2');
    fake.reply('extract', f.mortgageExtraction);
    fake.reply('link', { continues: null, storyline_title: null, links: [{ src: 'E1', dst: 'E2', type: 'causes', reason: 'r' }] },
      { continues: null, storyline_title: null, links: [{ src: 'E9', dst: 'E3', type: 'causes', reason: 'r' }] });
    expect((await ingest(f.mortgageArticle)).outcome).toBe('failed');
    // The rolled-back event still consumed id 3, so the retry's event is E4.
    fake.reply('link', { continues: null, storyline_title: null, links: [{ src: 'E4', dst: 'E4', type: 'causes', reason: 'r' }] },
      { continues: null, storyline_title: null, links: [{ src: 'E4', dst: 'E2', type: 'causes', reason: 'r' }, { src: 'E2', dst: 'E4', type: 'background_for', reason: 'r' }] });
    fake.reply('extract', f.mortgageExtraction);
    expect((await ingest({ ...f.mortgageArticle, body: `${f.mortgageArticle.body} Updated.` })).outcome).toBe('failed');
    const errors = await q<{ error: string }>('select error from documents where error is not null order by id');
    expect(errors.map((e) => e.error)).toEqual([expect.stringMatching(/link: invalid reply/), expect.stringMatching(/at most one link per candidate/)]);
    expect(await links()).toEqual([]);
    expect(await q('select id from events')).toHaveLength(2);
  });
});

describe('milestone 4: storylines', () => {
  async function collapseTakeoverHearing() {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    fake.reply('extract', f.bankExtraction);
    const collapse = await ingest(f.bankArticle);
    fake.reply('extract', f.saleExtraction);
    fake.reply('resolve_entity', { match: 'T2' });
    fake.reply('consolidate', { event_id: null, claims: [] });
    fake.reply('link', { continues: `E${collapse.eventId}`, storyline_title: 'Meridian Bank collapse and aftermath',
      links: [{ src: 'E2', dst: `E${collapse.eventId}`, type: 'reacts_to', reason: 'Regulator sold the failed bank to resolve it' }] });
    const sale = await ingest(f.saleArticle);
    expect(sale).toMatchObject({ outcome: 'new', eventId: '2', newLinks: 1 });
    return { collapse: collapse.eventId!, sale: sale.eventId! };
  }

  it('puts a collapse, its takeover and a later hearing in one storyline with one title, oldest first', async () => {
    const { collapse, sale } = await collapseTakeoverHearing();
    const [s] = await q<{ id: string; title: string }>('select id, title from storylines');
    expect(s!.title).toBe('Meridian Bank collapse and aftermath');
    expect((await getEvent(collapse)).storyline).toEqual({ storylineId: s!.id, title: s!.title });
    expect((await getEvent(sale)).storyline).toEqual({ storylineId: s!.id, title: s!.title });

    fake.reply('extract', f.hearingExtraction);
    fake.reply('link', { continues: `E${sale}`, storyline_title: null, links: [] });
    const hearing = await ingest(f.hearingArticle);
    expect(hearing).toMatchObject({ outcome: 'new', newLinks: 0 });
    expect(linkPrompt()).toContain(`storyline="S${s!.id}: Meridian Bank collapse and aftermath"`);

    expect(await q('select id from storylines')).toHaveLength(1);
    expect(await getStoryline(s!.id)).toEqual({
      storylineId: s!.id,
      title: 'Meridian Bank collapse and aftermath',
      events: [
        { eventId: collapse, title: f.bankExtraction.title, occurredAt: '2026-09-10' },
        { eventId: sale, title: f.saleExtraction.title, occurredAt: '2026-09-14' },
        { eventId: hearing.eventId, title: f.hearingExtraction.title, occurredAt: '2026-10-06' },
      ],
    });
  });

  it('leaves a stand-alone event without a storyline', async () => {
    const { collapse } = await collapseTakeoverHearing();
    fake.reply('extract', f.quakeExtraction1);
    fake.reply('link', f.noLinks);
    const quake = await ingest(f.quakeArticle1);
    expect((await getEvent(quake.eventId!)).storyline).toBeNull();
    expect((await getEvent(collapse)).storyline).not.toBeNull();
  });

  it('rejects a reply that titles an existing storyline, or continues without a title for a new one', async () => {
    const { sale } = await collapseTakeoverHearing();
    fake.reply('extract', f.hearingExtraction);
    fake.reply('link', { continues: `E${sale}`, storyline_title: 'Meridian hearings', links: [] },
      { continues: `E${sale}`, storyline_title: 'Meridian hearings', links: [] });
    const hearing = await ingest(f.hearingArticle);
    expect(hearing.outcome).toBe('failed');
    const [doc] = await q<{ error: string }>('select error from documents order by id desc limit 1');
    expect(doc!.error).toMatch(/link: invalid reply/);
    expect(await q('select id from storylines')).toHaveLength(1);
    expect(await q('select id from events')).toHaveLength(2);

    fake.reply('extract', f.quakeExtraction1);
    await ingest(f.quakeArticle1);
    fake.reply('extract', f.quakeExtraction2);
    fake.reply('link', { continues: 'E3', storyline_title: null, links: [] }, { continues: 'E3', storyline_title: null, links: [] });
    expect((await ingest(f.quakeArticle2)).outcome).toBe('failed');
  });
});

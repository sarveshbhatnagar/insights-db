import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUERY_MAX_TOOL_CALLS } from '../src/config.ts';
import * as api from '../src/index.ts';
import { ingest } from '../src/ingest.ts';
import { wordCount } from '../src/prompts.ts';
import { ask, getEvent, similarEvents } from '../src/query.ts';
import * as f from './fixtures/index.ts';
import { fake, freshDb, q } from './helpers.ts';

freshDb();

async function seed() {
  fake.reply('extract', f.rateExtraction);
  const rate = await ingest(f.rateArticle);
  fake.reply('extract', f.mortgageExtraction);
  fake.reply('link', { continues: null, storyline_title: null, links: [{ src: `E${rate.eventId}`, dst: 'E2', type: 'causes', reason: 'Higher rates raised mortgage costs, cutting applications' }] });
  const mortgage = await ingest(f.mortgageArticle);
  expect(mortgage.newLinks).toBe(1);
  fake.calls.length = 0;
  return { rate: rate.eventId!, mortgage: mortgage.eventId! };
}


describe('milestone 5: query agent', () => {
  it('answers from fetched claims with citations whose URLs the agent never saw', async () => {
    const { rate, mortgage } = await seed();
    const claims = (await getEvent(mortgage)).claims.map((c) => `C${c.claimId}`);
    const rateClaims = (await getEvent(rate)).claims.map((c) => `C${c.claimId}`);
    fake.reply('query',
      { tool_calls: [{ name: 'search_events', args: { query: 'mortgage applications' } }] },
      { tool_calls: [{ name: 'get_event', args: { event_id: `E${mortgage}` } }] },
      { tool_calls: [{ name: 'get_neighbors', args: { event_id: `E${mortgage}` } }] },
      { tool_calls: [{ name: 'get_event', args: { event_id: rate } }] },
      { answer: 'Mortgage applications fell 12 percent in the week to August 15 after the Federal Reserve raised its benchmark rate by half a point.', claim_ids: [claims[0], rateClaims[0]] },
    );
    const { answer, citations } = await ask('Why did mortgage applications fall?');
    expect(wordCount(answer)).toBeLessThanOrEqual(120);
    expect(citations.map((c) => `C${c.claimId}`)).toEqual([rateClaims[0], claims[0]]);
    expect(citations.map((c) => c.url)).toEqual([f.rateArticle.url, f.mortgageArticle.url]);
    expect(citations[0]!.source).toBe('Wire One');
    expect(citations[0]!.publishedAt.toISOString()).toBe('2026-08-01T18:00:00.000Z');
    const transcript = fake.transcript();
    expect(transcript).not.toContain('wire.one');
    expect(transcript).toMatch(/"event_id":"E\d+","title":"Mortgage applications fall 12 percent as rates climb"/);
    expect(transcript).toContain('"direction":"in"');
    // The system prompt is 6.6 and the question is the user message.
    expect(String(fake.calls[0]!.messages[0]!.content)).toMatch(/^You answer questions from insights_db/);
    expect(fake.calls[0]!.messages[1]!.content).toBe('Why did mortgage applications fall?');
    expect(fake.calls[0]!.tools!.map((t) => t.function.name)).toEqual(['search_events', 'get_event', 'get_storyline', 'get_neighbors', 'find_similar', 'search_claims']);
  });

  it('returns empty claim_ids for an unanswerable question', async () => {
    await seed();
    fake.reply('query',
      { tool_calls: [{ name: 'search_events', args: { query: 'olympic medals', k: 3 } }] },
      { answer: 'The database has no claims about Olympic medals.', claim_ids: [] },
    );
    const { answer, citations } = await ask('Who won the most Olympic medals?');
    expect(answer).toMatch(/no claims/);
    expect(citations).toEqual([]);
  });

  it('rejects claim ids the agent did not retrieve, and answers over 120 words', async () => {
    const { mortgage } = await seed();
    const [claim] = (await getEvent(mortgage)).claims;
    fake.reply('query',
      { answer: 'Applications fell.', claim_ids: [`C${claim!.claimId}`] },
      { tool_calls: [{ name: 'get_event', args: { event_id: mortgage } }] },
      { answer: Array(121).fill('word').join(' '), claim_ids: [`C${claim!.claimId}`] },
    );
    await expect(ask('What happened to mortgage applications?')).rejects.toThrow(/invalid reply after retry/);
  });

  it('stops offering tools once the call budget is spent', async () => {
    const { mortgage } = await seed();
    fake.reply('query', ...Array.from({ length: QUERY_MAX_TOOL_CALLS }, () => ({ tool_calls: [{ name: 'get_event', args: { event_id: mortgage } }] })));
    fake.reply('query', { tool_calls: [{ name: 'get_event', args: { event_id: mortgage } }] });
    fake.reply('query', { answer: 'Done.', claim_ids: [] });
    await ask('Loop?');
    const last = fake.calls.at(-1)!;
    expect(last.tools).toBeUndefined();
    expect(String(last.messages.at(-1)!.content)).toMatch(/budget exhausted/);
    expect(fake.calls).toHaveLength(QUERY_MAX_TOOL_CALLS + 2);
  });

  it('search_events is hybrid: a full-text hit surfaces without a vector match', async () => {
    const { mortgage, rate } = await seed();
    fake.reply('query',
      { tool_calls: [{ name: 'search_events', args: { query: 'Ruiz inflation remained too high', k: 2, date_from: '2026-07-01' } }] },
      { answer: 'x', claim_ids: [] },
    );
    await ask('q');
    const result = JSON.parse(String(fake.calls[1]!.messages.at(-1)!.content)) as { event_id: string }[];
    expect(result.map((r) => r.event_id)).toEqual([`E${rate}`, `E${mortgage}`]);
  });
});

describe('milestone 5: similar events and package', () => {
  it('ranks a different bank failure above same-entity events', async () => {
    fake.alias('FDIC', 'Federal Deposit Insurance Corporation');
    fake.reply('extract', f.bankExtraction);
    const bank = await ingest(f.bankArticle);
    fake.reply('extract', f.saleExtraction);
    fake.reply('resolve_entity', { match: 'T2' });
    fake.reply('consolidate', { event_id: null, claims: [] });
    fake.reply('link', f.noLinks);
    await ingest(f.saleArticle);
    fake.reply('extract', f.hearingExtraction);
    fake.reply('link', f.noLinks);
    await ingest(f.hearingArticle);
    fake.reply('extract', f.harborExtraction);
    fake.reply('link', f.noLinks);
    const harbor = await ingest(f.harborArticle);

    const similar = await similarEvents(bank.eventId!, 3);
    expect(similar[0]!.eventId).toBe(harbor.eventId);
    expect(similar[0]!.pattern).toBe(f.harborExtraction.pattern);
    expect(similar.map((s) => s.eventId)).not.toContain(bank.eventId);
    expect(similar[0]!.score).toBeGreaterThan(similar[1]!.score);
  });

  it('exports the public functions', () => {
    expect(Object.keys(api).sort()).toEqual([
      'ask', 'detachDocument', 'getEvent', 'getGuidance', 'getStoryline', 'ingest', 'ingestMany', 'init', 'listClaims',
      'listEntities', 'mergeEntities', 'relink', 'retryFailed', 'searchEvents', 'setGuidance', 'similarEvents',
    ]);
  });

  it('npm pack produces a package whose bin runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'insights-db-pack-'));
    const tarball = execFileSync('npm', ['pack', '--pack-destination', dir, '--ignore-scripts=false'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').at(-1)!;
    writeFileSync(join(dir, 'package.json'), '{"name":"probe","private":true}');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', join(dir, tarball)], { cwd: dir, stdio: 'ignore' });
    const bin = join(dir, 'node_modules', '.bin', 'insights-db');
    const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL };

    let usage = '';
    try {
      execFileSync(bin, [], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const e = err as { status: number; stderr: string };
      expect(e.status).toBe(2);
      usage = e.stderr;
    }
    expect(usage).toContain('insights-db ingest <file.jsonl>');

    writeFileSync(join(dir, 'guidance.json'), JSON.stringify({ domain: 'News articles.', query: 'Be brief.' }));
    execFileSync(bin, ['guidance', join(dir, 'guidance.json')], { env, stdio: 'ignore' });
    expect(await q('select step from guidance order by step')).toEqual([{ step: 'domain' }, { step: 'query' }]);
  }, 120_000);
});

import { describe, expect, it } from 'vitest';
import { pool } from '../src/db.ts';
import { resolveEntities } from '../src/entities.ts';
import { extract } from '../src/extract.ts';
import { getGuidance, render, setGuidance } from '../src/prompts.ts';
import { bankArticle, bankExtraction } from './fixtures/index.ts';
import { fake, freshDb, q } from './helpers.ts';

freshDb();

const doc = {
  id: '1',
  title: bankArticle.title!,
  body: bankArticle.body,
  source: bankArticle.source!,
  documentDate: new Date('2026-09-11T08:00:00Z'),
};

describe('milestone 2: extraction', () => {
  it('yields a valid extraction from a fixture article', async () => {
    fake.reply('extract', bankExtraction);
    const result = await extract(doc);
    expect(result).toEqual(bankExtraction);
    const prompt = String(fake.calls[0]!.messages[1]!.content);
    expect(prompt).toContain('<document source="Wire One" date="2026-09-11">');
    expect(prompt).toContain(`${bankArticle.title}\n\n${bankArticle.body}`);
    expect(String(fake.calls[0]!.messages[0]!.content)).toMatch(/^You are one step inside insights_db/);
  });

  it('omits the source attribute and title line when the document has none', async () => {
    fake.reply('extract', bankExtraction);
    await extract({ ...doc, title: null, source: null });
    const prompt = String(fake.calls[0]!.messages[1]!.content);
    expect(prompt).toContain(`<document date="2026-09-11">\n${bankArticle.body}\n</document>`);
  });

  it('rejects a reply with an extra field', async () => {
    const bad = { ...bankExtraction, confidence: 0.9 };
    fake.reply('extract', bad, bad);
    await expect(extract(doc)).rejects.toThrow(/invalid reply after retry/);
    expect(fake.calls).toHaveLength(2);
    expect(String(fake.calls[1]!.messages.at(-1)!.content)).toMatch(/invalid/);
  });

  it('rejects 11 claims', async () => {
    const bad = { ...bankExtraction, claims: Array.from({ length: 11 }, (_, i) => `Claim number ${i} is stated.`) };
    fake.reply('extract', bad, bad);
    await expect(extract(doc)).rejects.toThrow(/invalid reply/);
  });

  it('rejects a 40-word claim', async () => {
    const bad = { ...bankExtraction, claims: [Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')] };
    fake.reply('extract', bad, bad);
    await expect(extract(doc)).rejects.toThrow(/over 30 words/);
  });

  it('accepts a corrected reply on the single retry', async () => {
    fake.reply('extract', { ...bankExtraction, notes: 'x' }, bankExtraction);
    expect(await extract(doc)).toEqual(bankExtraction);
  });
});

describe('milestone 2: entity resolution', () => {
  const resolve = (name: string, type: 'person' | 'org' | 'place' | 'other') =>
    resolveEntities(pool, [{ name, type, role: 'actor' }], 'Rate decision');

  it('reuses an entity on an exact or alias match without an LLM call', async () => {
    const [a] = await resolve('Federal Reserve', 'org');
    const [b] = await resolve('federal reserve', 'org');
    expect(b!.entityId).toBe(a!.entityId);
    expect(fake.calls).toHaveLength(0);
  });

  it('merges "Federal Reserve" and "the Fed" into one entity via the LLM', async () => {
    fake.alias('the Fed', 'Federal Reserve');
    const [a] = await resolve('Federal Reserve', 'org');
    fake.reply('resolve_entity', { match: `T${a!.entityId}` });
    const [b] = await resolve('the Fed', 'org');
    expect(b!.entityId).toBe(a!.entityId);
    const prompt = String(fake.calls[0]!.messages[1]!.content);
    expect(prompt).toContain('Name: the Fed (org), from a document about: Rate decision');
    expect(prompt).toContain(`T${a!.entityId} | Federal Reserve | org | also known as: `);
    const rows = await q<{ aliases: string[] }>('select aliases from entities');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.aliases).toEqual(['the Fed']);
    // The alias now matches in code, so a third mention costs nothing.
    const [c] = await resolve('THE FED', 'org');
    expect(c!.entityId).toBe(a!.entityId);
    expect(fake.calls).toHaveLength(1);
  });

  it('keeps a parent company and its subsidiary as two entities', async () => {
    fake.alias('Acme Holdings Europe', 'Acme Holdings');
    const [parent] = await resolve('Acme Holdings', 'org');
    fake.reply('resolve_entity', { match: null });
    const [sub] = await resolve('Acme Holdings Europe', 'org');
    expect(sub!.entityId).not.toBe(parent!.entityId);
    expect(await q('select id from entities')).toHaveLength(2);
  });

  it('rejects a match id that was not offered', async () => {
    fake.alias('the Fed', 'Federal Reserve');
    await resolve('Federal Reserve', 'org');
    fake.reply('resolve_entity', { match: 'T999' }, { match: 'T999' });
    await expect(resolve('the Fed', 'org')).rejects.toThrow(/invalid reply/);
  });

  it('does not call the LLM when no neighbour is close enough', async () => {
    await resolve('Federal Reserve', 'org');
    const [other] = await resolve('Ohio Department of Commerce', 'org');
    expect(other).toBeDefined();
    expect(fake.calls).toHaveLength(0);
    expect(await q('select id from entities')).toHaveLength(2);
  });
});

describe('milestone 2: owner guidance', () => {
  it('renders guidance inside its tagged block and drops the block when absent', async () => {
    const without = await render('extract', { document_date: '2026-09-11', body: 'b' });
    expect(without).not.toContain('<owner_guidance>');
    expect(without.endsWith('as it appears in "entities".\n')).toBe(true);
    const shared = await render('shared');
    expect(shared).not.toContain('<domain>\n');
    expect(shared.endsWith('the schema and rules win.\n')).toBe(true);

    await setGuidance('extract', 'Ignore the outlet.');
    await setGuidance('domain', 'News articles.');
    const withIt = await render('extract', { document_date: '2026-09-11', body: 'b' });
    expect(withIt.endsWith('as it appears in "entities".\n\n<owner_guidance>\nIgnore the outlet.\n</owner_guidance>\n')).toBe(true);
    expect((await render('shared')).endsWith('rules win.\n\n<domain>\nNews articles.\n</domain>\n')).toBe(true);
    const query = await render('query');
    expect(query).toContain('<domain>\nNews articles.\n</domain>');
    expect(query).not.toContain('<owner_guidance>\n');
    expect(await getGuidance()).toEqual({ extract: 'Ignore the outlet.', domain: 'News articles.' });

    await setGuidance('extract', null);
    expect(await getGuidance()).toEqual({ domain: 'News articles.' });
  });

  it('rejects guidance over 150 words or for an unknown step', async () => {
    await expect(setGuidance('extract', Array(151).fill('word').join(' '))).rejects.toThrow(/150/);
    await expect(setGuidance('summarize', 'x')).rejects.toThrow(/unknown guidance step/);
    await setGuidance('extract', Array(150).fill('word').join(' '));
    expect(Object.keys(await getGuidance())).toEqual(['extract']);
  });

  it('leaves no unfilled slot in any rendered prompt', async () => {
    const shared = await render('shared');
    const query = await render('query');
    for (const text of [shared, query]) expect(text).not.toMatch(/\{[a-z_]+\}/);
  });
});

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { pool } from './db.ts';

export const STEPS = ['domain', 'extract', 'resolve_entity', 'consolidate', 'verify', 'link', 'query'] as const;
export type Step = (typeof STEPS)[number];

const NAMES = ['shared', 'extract', 'resolve_entity', 'consolidate', 'link', 'query'] as const;
type PromptName = (typeof NAMES)[number];

const dir = new URL('../prompts/', import.meta.url);
const templates = Object.fromEntries(
  NAMES.map((n) => [n, readFileSync(new URL(`${n}.md`, dir), 'utf8')]),
) as Record<PromptName, string>;

// List templates in the prompt files, replaced whole by a rendered list.
// Longer literals come first so a shorter one cannot match inside them.
const REGIONS: Partial<Record<PromptName, [literal: string, slot: string][]>> = {
  resolve_entity: [['{id} | {name} | {type} | also known as: {aliases}\n...', 'candidates']],
  consolidate: [
    [
      '<event id="{E-id}" title="{title}" type="{event_type}" occurred_at="{date}" entities="{entity names}">\n' +
        '{C-id}. ({asserted_at}) {"[hidden] " if hidden}{"[speculation] " if speculation}{claim text}\n...\n</event>\n...',
      'candidates',
    ],
    ['N1. {claim text}\nN2. {claim text}\n...', 'new_claims'],
  ],
  link: [
    [
      '<event id="{E-id}" title="{title}" occurred_at="{date}"\n       storyline="{S-id}: {storyline title}" | "none">\n' +
        '{live claim texts, one per line}\n</event>\n...',
      'candidates',
    ],
    ['{live claim texts, one per line}', 'new_claims'],
  ],
};

const SLOT = /\{([A-Za-z][A-Za-z0-9_ -]*)\}/g;

export type Slots = Record<string, string | undefined>;

export async function render(name: PromptName, slots: Slots = {}): Promise<string> {
  const guidance = await getGuidance();
  let text = templates[name];
  for (const [literal, slot] of REGIONS[name] ?? []) {
    if (!text.includes(literal)) throw new Error(`prompt ${name}: list template not found`);
    text = text.replace(literal, slots[slot] ?? '');
  }
  // Owner blocks vanish entirely when the owner set nothing.
  text = text.replace(/\n\n<(domain|owner_guidance)>\n\{(domain|guidance)\}\n<\/\1>/g, (_, tag: string, slot: string) => {
    const value = slot === 'domain' ? guidance.domain : guidance[name as Step];
    return value ? `\n\n<${tag}>\n${value}\n</${tag}>` : '';
  });
  // An attribute or a whole line for a value the document does not have is dropped.
  text = text.replace(/ ([a-z_]+)="\{([a-z_]+)\}"/g, (m, _attr, slot: string) => (slots[slot] === undefined ? '' : m));
  text = text.replace(/^\{([a-z_]+)\}\n\n?/gm, (m, slot: string) => (slots[slot] === undefined ? '' : m));
  text = text.replace(SLOT, (m, slot: string) => {
    const value = slots[slot];
    if (value === undefined) throw new Error(`prompt ${name}: slot ${m} not filled`);
    return value;
  });
  return text;
}

const firstLine = (s: string): string => s.slice(0, s.indexOf('\n'));

export function stepOf(system: string, user: string): string {
  for (const name of ['extract', 'resolve_entity', 'consolidate', 'link'] as const) {
    if (user.startsWith(firstLine(templates[name]))) return name;
  }
  return system.startsWith(firstLine(templates.query)) ? 'query' : 'unknown';
}

export const isoDate = (d: Date | string): string => (typeof d === 'string' ? d : d.toISOString().slice(0, 10));

export const wordCount = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);
export const maxWords = (n: number) =>
  z.string().trim().min(1).refine((s) => wordCount(s) <= n, {
    error: (issue) => `over ${n} words (${wordCount(String(issue.input))}); shorten it or split it`,
  });

// Ids in prompts carry a letter prefix (E17, C101, N3, T5, S4).
export const pid = (prefix: string, id: string | number): string => `${prefix}${id}`;
export const unpid = (s: string): string => s.slice(1);
// z.enum needs at least one value; with none, nothing may be named.
export const idEnum = (ids: string[]) => (ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never());

export async function setGuidance(step: string, text: string | null): Promise<void> {
  if (!(STEPS as readonly string[]).includes(step)) throw new Error(`unknown guidance step: ${step}`);
  if (text === null) {
    await pool.query('delete from guidance where step = $1', [step]);
    return;
  }
  const words = wordCount(text);
  if (words === 0) throw new Error('guidance text is empty; pass null to remove it');
  if (words > 150) throw new Error(`guidance for ${step} is ${words} words; the limit is 150`);
  await pool.query(
    `insert into guidance (step, text) values ($1, $2)
     on conflict (step) do update set text = excluded.text, updated_at = now()`,
    [step, text.trim()],
  );
}

export async function getGuidance(): Promise<Partial<Record<Step, string>>> {
  const { rows } = await pool.query<{ step: Step; text: string }>('select step, text from guidance');
  return Object.fromEntries(rows.map((r) => [r.step, r.text]));
}

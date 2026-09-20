// Milestone 6 eval: ingests the labeled article set with live models and checks
// the section 9 targets. Run with: npm run eval [-- path/to/set.json]
//
// eval/set.json is a fictional 2026 news corpus (104 articles, 32 events) written
// for this eval; swap in real labeled articles using the same format.
//
// set.json:
// {
//   "articles":   [{ "title", "body", "publishedAt", "source", "url",
//                    "event": "<label>", "forecasts": ["sentence stored as speculation, never fact"] }],
//   "links":      [{ "src": "<label>", "dst": "<label>", "type": "causes" }],
//   "storylines": [["<label>", "<label>", ...]],
//   "questions":  [{ "question": "...", "events": ["<label>"], "facts": ["expected supporting fact"] }]
// }
import { subscribe } from 'node:diagnostics_channel';
import { readFileSync } from 'node:fs';
import { CLAIM_DUP_COSINE } from '../src/config.ts';
import { applySchema, liveClaim, pool, vec } from '../src/db.ts';
import { ask, ingest, setGuidance, type DocumentIn } from '../src/index.ts';
import { embed } from '../src/llm.ts';

type Article = DocumentIn & { event: string; forecasts?: string[] };
type Set = {
  articles: Article[];
  links: { src: string; dst: string; type: string }[];
  storylines: string[][];
  questions: { question: string; events: string[]; facts?: string[] }[];
};

const BUDGETS: Record<string, number> = { extract: 600, resolve_entity: 15, consolidate: 80, link: 140, query: 250 };

const set = JSON.parse(readFileSync(process.argv[2] ?? new URL('./set.json', import.meta.url), 'utf8')) as Set;

const tokens = new Map<string, number[]>();
subscribe('insights-db:llm', (msg) => {
  const { step, outputTokens } = msg as { step: string; outputTokens: number };
  tokens.set(step, [...(tokens.get(step) ?? []), outputTokens]);
});

const tables = await pool.query("select 1 from information_schema.tables where table_name = 'documents'");
if (tables.rowCount === 0) await applySchema();
else if (((await pool.query('select count(*) as n from documents')).rows[0] as { n: string }).n !== '0') {
  console.error('eval needs an empty database; point DATABASE_URL at a scratch one');
  process.exit(2);
}

const preset = JSON.parse(readFileSync(new URL('../presets/news.json', import.meta.url), 'utf8')) as Record<string, string>;
for (const [step, text] of Object.entries(preset)) await setGuidance(step, text);

const labelOfEvent = new Map<string, Map<string, number>>();
const docs: { label: string; eventId: string }[] = [];
const sorted = [...set.articles].sort((a, b) => String(a.publishedAt ?? '').localeCompare(String(b.publishedAt ?? '')));
for (const article of sorted) {
  const { event: label, forecasts: _, ...doc } = article;
  const result = await ingest(doc);
  console.error(`${result.outcome.padEnd(9)} ${label.padEnd(20)} ${article.title ?? ''}`);
  if (result.outcome === 'failed' || !result.eventId) continue;
  docs.push({ label, eventId: result.eventId });
  const votes = labelOfEvent.get(result.eventId) ?? new Map<string, number>();
  votes.set(label, (votes.get(label) ?? 0) + 1);
  labelOfEvent.set(result.eventId, votes);
}
const eventLabel = (eventId: string): string =>
  [...(labelOfEvent.get(eventId) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '?';

// Merge precision and recall over pairs of documents.
let tp = 0, fp = 0, fn = 0;
for (let i = 0; i < docs.length; i++) {
  for (let j = i + 1; j < docs.length; j++) {
    const same = docs[i]!.eventId === docs[j]!.eventId;
    const should = docs[i]!.label === docs[j]!.label;
    if (same && should) tp++;
    else if (same) fp++;
    else if (should) fn++;
  }
}
const ratio = (a: number, b: number): number => (b === 0 ? 1 : a / b);

const redundant = await pool.query(
  `select count(*) as n from claims a join claims b on a.event_id = b.event_id and a.id < b.id
   where ${liveClaim('a')} and ${liveClaim('b')} and 1 - (a.embedding <=> b.embedding) >= $1`,
  [CLAIM_DUP_COSINE],
);

const links = await pool.query<{ src: string; dst: string; type: string }>('select src, dst, type from links');
const linkOk = links.rows.filter((l) =>
  set.links.some((x) => x.src === eventLabel(l.src) && x.dst === eventLabel(l.dst) && x.type === l.type),
).length;

const storyPairs = await pool.query<{ a: string; b: string }>(
  'select a.id as a, b.id as b from events a join events b on a.storyline_id = b.storyline_id and a.id < b.id',
);
const storyOk = storyPairs.rows.filter((p) =>
  set.storylines.some((s) => s.includes(eventLabel(p.a)) && s.includes(eventLabel(p.b))),
).length;

let answered = 0;
for (const question of set.questions) {
  try {
    const { citations } = await ask(question.question);
    const events = await pool.query<{ event_id: string }>('select event_id from claims where id = any($1::bigint[])', [
      citations.map((c) => c.claimId),
    ]);
    const relevant = citations.length > 0 && events.rows.every((r) => question.events.includes(eventLabel(r.event_id)));
    if (relevant) answered++;
    console.error(`${relevant ? 'ok  ' : 'miss'} ${question.question}`);
  } catch (err) {
    console.error(`fail ${question.question}: ${(err as Error).message}`);
  }
}

let forecastsAsFacts = 0;
const forecasts = set.articles.flatMap((a) => a.forecasts ?? []);
if (forecasts.length > 0) {
  const embeddings = await embed(forecasts);
  for (const e of embeddings) {
    const hit = await pool.query(
      `select 1 from claims c where ${liveClaim('c')} and 1 - (c.embedding <=> $1::vector) >= $2 limit 1`,
      [vec(e), CLAIM_DUP_COSINE],
    );
    if (hit.rowCount) forecastsAsFacts++;
  }
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const rows: [metric: string, value: string, target: string, pass: boolean][] = [
  ['merge precision', ratio(tp, tp + fp).toFixed(2), '>= 0.95', ratio(tp, tp + fp) >= 0.95],
  ['merge recall', ratio(tp, tp + fn).toFixed(2), '>= 0.85', ratio(tp, tp + fn) >= 0.85],
  ['redundant claim pairs', String(redundant.rows[0].n), '0', redundant.rows[0].n === '0'],
  ['link precision', `${ratio(linkOk, links.rowCount ?? 0).toFixed(2)} (${links.rowCount} links)`, '>= 0.90', ratio(linkOk, links.rowCount ?? 0) >= 0.9],
  ['questions answered', `${answered} of ${set.questions.length}`, '>= 8 of 10', answered >= Math.ceil(set.questions.length * 0.8)],
  ['storyline precision', `${ratio(storyOk, storyPairs.rowCount ?? 0).toFixed(2)} (${storyPairs.rowCount} pairs)`, '>= 0.90', ratio(storyOk, storyPairs.rowCount ?? 0) >= 0.9],
  ['forecasts stored as facts', `${forecastsAsFacts} of ${forecasts.length}`, '0', forecastsAsFacts === 0],
  ...Object.entries(BUDGETS).map(([step, budget]): [string, string, string, boolean] => {
    const m = mean(tokens.get(step) ?? []);
    return [`mean output tokens: ${step}`, `${m.toFixed(0)} (${tokens.get(step)?.length ?? 0} calls)`, `<= ${budget}`, m <= budget];
  }),
];

const width = Math.max(...rows.map((r) => r[0].length));
for (const [metric, value, target, pass] of rows) {
  console.log(`${pass ? 'PASS' : 'MISS'}  ${metric.padEnd(width)}  ${value.padEnd(22)}  ${target}`);
}
await pool.end();
process.exit(rows.every((r) => r[3]) ? 0 : 1);

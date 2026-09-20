# Library

```ts
import { openInsights, type DocumentIn } from 'insights-db';

const db = openInsights({ connectionString: process.env.DATABASE_URL });   // or { pool }, or {} for DATABASE_URL
await db.init();

const docs: DocumentIn[] = [
  { body: 'The Federal Reserve raised its benchmark interest rate by half a percentage point …',
    title: 'Federal Reserve raises rates by half a point', publishedAt: '2026-08-01T18:00:00Z',
    source: 'Wire One', url: 'https://wire.one/federal-reserve-raises-rates-by-half-a-point' },
  { body: 'Applications for home loans fell 12 percent in the week to August 15 …', publishedAt: '2026-08-20' },
];
const results = await db.ingestMany(docs, { concurrency: 4 });
// results[0] → { documentId: '1', eventId: '1', outcome: 'new', newClaims: 7, newLinks: 0, usage: { calls: 5, … } }

const { answer, citations } = await db.ask('Why did mortgage applications fall?');
// citations → [{ claimId: '1', text: 'The Federal Reserve raised …', source: 'Wire One', url: '…', publishedAt: Date }, …]

const event = await db.getEvent(results[1].eventId!);
// event.links → [{ eventId: '1', title: 'Federal Reserve raises …', type: 'causes', direction: 'in', reason: '…' }]

await db.end();
```

`openInsights` returns an `Insights` handle: a `pg.Pool` (yours or one it opens) plus the functions in the table below as methods. Open several to work with several databases. The same functions are also exported directly (`import { ingest, ask } from 'insights-db'`) and bind to `DATABASE_URL` on first use.

```ts
type DocumentIn = {
  body: string;                  // required, plain text, non-empty
  title?: string;
  publishedAt?: string | Date;   // ISO 8601; a string without an offset is read as UTC; absent = ingest time
  source?: string;               // who produced it; appears in citations
  url?: string;                  // a link or any caller-side reference; appears in citations
};

type IngestResult = {
  documentId: string;
  eventId: string | null;        // null for a failed document
  outcome: 'duplicate' | 'merged' | 'new' | 'failed';
  newClaims: number;
  newLinks: number;
  usage: { calls: number; inputTokens: number; outputTokens: number; reasoningTokens: number };
};
```

Ids are Postgres bigints and arrive as strings. Data with no natural title or date (chat messages, tickets, rows from another system) goes in as text in `body`; the library parses no formats. Invalid input (empty `body`, unparseable `publishedAt`) rejects the whole batch before anything is stored.

| Method | Returns | Notes |
| --- | --- | --- |
| `init()` | — | Applies `db/schema.sql`. Idempotent. |
| `ingest(doc)` | `IngestResult` | One document; equivalent to `ingestMany([doc])`. |
| `ingestMany(docs, { concurrency? })` | `IngestResult[]` | In input order. Dedup runs serially so a repeat inside the batch is a duplicate; the LLM steps run `concurrency` (default 4) at a time. |
| `retryFailed({ concurrency?, limit? })` | `IngestResult[]` | Re-runs failed documents in place, oldest first, up to `limit` (default 100). |
| `ask(question)` | `{ answer, citations }` | Query agent with at most `QUERY_MAX_TOOL_CALLS` tool calls. `citations: { claimId, text, source, url, publishedAt }[]`. |
| `searchEvents(query, { k?, dateFrom?, dateTo? })` | `{ eventId, title, occurredAt }[]` | Hybrid: embedding cosine and full text over claims and titles, fused by reciprocal rank. One embedding call, no chat model. |
| `similarEvents(eventId, k = 5)` | `{ eventId, title, occurredAt, pattern, score }[]` | By pattern embedding. Free-text analog search goes through `ask`. |
| `getEvent(eventId, { includeHistory?, asOf? })` | `EventDetail` | Title, type, pattern, dates, storyline, entities with roles, live claims, speculation, links (with direction and reason) and source documents. History adds superseded and hidden claims. |
| `getStoryline(storylineId)` | `{ storylineId, title, events }` | Events as `{ eventId, title, occurredAt }`, oldest first. |
| `listClaims({ query?, speculation?, verdict?, k? })` | `ClaimHit[]` | Claims with event id, kind, verdict, the claims they are disputed with; hidden claims included. |
| `listEntities({ query?, type?, k? })` | `EntityHit[]` | `{ entityId, name, type, aliases, events }`. |
| `relink(eventId)` | `number` | Links inserted. No LLM call when there is nothing new to judge. |
| `setGuidance(step, text \| null)` | — | Up to 150 words per step; `null` removes it. Applies to documents ingested afterwards. |
| `getGuidance()` | `{ [step]: text }` | Every step that has guidance. |
| `mergeEntities(keepId, dropId)` | — | Repoints events, merges aliases, deletes the dropped entity. |
| `detachDocument(documentId)` | `IngestResult` | Undoes a wrong merge: removes the document's claims and re-ingests it with the old event excluded. |
| `end()` | — | Closes the pool. |

Exported types: `DocumentIn`, `IngestOptions`, `IngestResult`, `Usage`, `EventDetail`, `Claim`, `Citation`, `EventHit`, `ClaimHit`, `EntityHit`, `SimilarEvent`, `GetEventOptions`, `Step`, `ConnectionOptions`, and the read API's `EventRecord`, `EventEntity`, `EventFilters`, `ListQuery`, `Page`, `SimilarQuery`, `Vector`, `TypeStats`, `EntityStats`, `AsOf`.

## Read API

`db.events` hands out events as plain records with no LLM call, for a system that keeps its own context per event and must never see anything later than a chosen instant.

```ts
const page = await db.events.list({ from: '2026-08-01', limit: 50 });
// page.items[0] → { id: '1', occurredAt: '2026-08-01', observedAt: Date, eventType: 'interest_rate_change',
//                   title: 'Federal Reserve raises …', pattern: '…', storylineId: null,
//                   entities: [{ id: '1', name: 'Federal Reserve', type: 'org', role: 'rate setter' }, …],
//                   claims: [{ claimId: '1', text: '…', assertedAt: Date, kind: 'fact', supersededBy: null, … }, …] }
const more = page.nextCursor && await db.events.list({ cursor: page.nextCursor });

const then = await db.events.getMany(['1', '2'], { asOf: '2026-08-10' });   // only E1: E2 was not observed until Aug 20
const alike = await db.events.similar({ eventId: '2', k: 5, minScore: 0.4 });            // by pattern, written once
const alikeNow = await db.events.similar({ eventId: '2', k: 5 }, 'content');            // by title + live claims, as of today
const types = await db.events.types();          // [{ eventType: 'interest_rate_change', count: 1, from: '2026-08-01', to: '2026-08-01' }, …]
const who = await db.events.entities({ from: '2026-08-01' });   // [{ id, name, type, count, from, to }, …]
```

| Function | Notes |
| --- | --- |
| `getMany(ids, { asOf? })` | In the order asked. Ids that do not exist, or were not yet observed at `asOf`, are left out, so this is what a caller sweeps its own store with: deletion is not cascaded between systems. |
| `list({ …filters, limit?, cursor?, order? })` | A keyset page on `(occurredAt, id)`, ascending unless `order: 'desc'`, `limit` 50 by default; pass `nextCursor` back for the next page. |
| `similar({ eventId \| embedding, k?, minScore?, filters? }, vector?)` | Nearest by cosine over `'pattern'` (default; written once at insert, so a ranking for a past `asOf` is the one that would have been computed then) or `'content'` (rewritten as claims merge). Adds `score`. |
| `types()` | Event types in use with counts and `occurredAt` span, most frequent first. |
| `entities({ eventType?, from?, to?, storylineId?, limit? })` | Entities in use with counts and span, for choosing filters. |

Filters, shared by `list` and `similar`: `eventType` (one or several), `entityIds` (events touching any of them), `storylineId` (one or several), `from` and `to` (bounds on `occurredAt`, inclusive), `excludeIds`, and `asOf`.

`asOf` (a `Date` or ISO string) returns only events observed by then, each as it stood then: claims asserted by `asOf`, and a supersession counted only once the superseding claim was itself asserted, so a later correction is not yet known. `getEvent(id, { asOf })` does the same and also limits `documents` to those dated by then. Records list current facts and speculation together, each with its `kind`; superseded and hidden claims stay out.

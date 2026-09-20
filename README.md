# insights-db

TypeScript library and CLI that ingests documents, stores each real-world event once with its facts, links related events, and answers questions over the result. One Postgres database with pgvector, one LLM provider, no server.

- [What it does](#what-it-does)
- [Quickstart](#quickstart)
- [CLI](#cli)
- [Library](#library)
- [Read API](#read-api)
- [Guidance and presets](#guidance-and-presets)
- [Configuration](#configuration)
- [Operations](#operations)
- [Development](#development)

The [design doc](docs/design.md) is the spec, [DECISIONS.md](DECISIONS.md) records choices made where it is silent, and [CHANGELOG.md](CHANGELOG.md) lists what each version added.

## What it does

Feed it documents, news articles first. Each one is reduced to the single event it reports and the facts it asserts about that event; a second report of the same event adds only the facts the store did not have yet. Events that bear on each other are linked, and a question is answered by an agent that reads the store and cites the claims it used.

```
 documents (raw, never edited)         events (one row per real-world event)
 ┌────────────────────────────┐        ┌──────────────────────────────────────┐
 │ Wire One  · Fed raises …   │──new──▶│ E1  Fed raises rates by half a point │
 │ Capital T.· Fed delivers … │─merge─▶│     C1 raised to 5.5–5.75 percent    │
 │ Wire One  · Fed raises …   │─dup──▶ │     C3 two members dissented         │
 │   (republished wire copy)  │        │     C13 the vote was 10 to 2  ◀──────── added by the merge
 └────────────────────────────┘        └──────────────────┬───────────────────┘
                                                          │ causes
 ┌────────────────────────────┐        ┌──────────────────▼───────────────────┐
 │ Wire One  · Mortgage apps… │──new──▶│ E2  Mortgage applications fall 12 %  │
 └────────────────────────────┘        │     C8 fell 12 % in week to Aug 15   │
                                       │     C12 [speculation] expected to …  │
                                       └──────────────────────────────────────┘
```

The vocabulary, which the API uses throughout:

| Term | Meaning |
| --- | --- |
| **Document** | What you ingest: a `body` and, optionally, `title`, `publishedAt`, `source`, `url`. Stored as given and never edited or deleted. Every document ends up in one of four states: `duplicate` (exact or near copy of a stored document, no LLM call), `new` (created an event), `merged` (added to an existing event), `failed` (see [Operations](#operations)). |
| **Event** | One real-world occurrence, stored once: a title, a snake_case `eventType`, a calendar day `occurredAt`, an entity-free `pattern` sentence used for similarity, and its entities with roles. An event exists only because a document created it. |
| **Claim** | One fact about an event, at most 30 words, attributed to the first document that asserted it. `kind` is `fact` or `speculation`; forecasts, expectations and hypotheticals are stored as speculation, never as facts. |
| **Supersession** | A later claim that corrects an earlier value (a death toll rises, a figure is revised) sets `supersededBy` on the old one. The old claim stays for history; only the current one is *live*. |
| **Disputed claim** | Two claims that contradict each other with neither clearly later point at each other through `disputedWith`. Both stay live; the query agent reports that reports differ. |
| **Hidden claim** | A claim that failed the optional verification step (`verdict` of `refuted`, or `unsupported` in strict mode). Hidden claims leave events, search and answers but remain findable through `listClaims`. Verification is not built yet, so nothing is hidden today. |
| **Entity** | A person, organisation, place or other named thing, resolved once across documents: "Federal Reserve" and "the Fed" become one entity with aliases. |
| **Link** | A directed, typed edge between two events, read as *src type dst*: `causes`, `reacts_to`, `contradicts`, `background_for`. Each carries a one-line reason. |
| **Storyline** | One ongoing story told through several events (a bank collapse, its sale, the hearing, the lawsuit). An event belongs to at most one; the title is set once when the storyline is created. |
| **`occurredAt` vs `observedAt`** | Two clocks. `occurredAt` is the day the event happened (`YYYY-MM-DD`, read it as 00:00 UTC). `observedAt` is when the store first heard of it: the earliest of its documents' dates, where a document's date is `publishedAt` or, failing that, its ingest time. The read API's `asOf` cuts on `observedAt`. |

Every fact, entity, event and link lives in exactly one row; summaries, timelines and citations are computed on read. The LLM is called only for judgments code cannot make (what the event is, whether two reports describe the same one, how two events relate) and sees a handful of candidates at a time.

## Quickstart

Requirements: Node 22+, Postgres 16 with the pgvector extension (local, container or managed: Neon, Supabase, RDS all work), a `DEEPSEEK_API_KEY` for chat and an `OPENAI_API_KEY` for embeddings. The provider pairing is fixed, see [Configuration](#configuration).

Where the data lives is Postgres's choice: put the cluster's data directory on the disk you want (`initdb -D /Volumes/ssd/pgdata`) or give the database a tablespace there. The library only needs `DATABASE_URL`.

A throwaway database for development:

```sh
docker run -d --name insights-db-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=insights_db -p 5433:5432 pgvector/pgvector:pg16
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/insights_db
export DEEPSEEK_API_KEY=… OPENAI_API_KEY=…
```

Install and create the schema (`init` is idempotent; re-run it after upgrading):

```sh
npm install insights-db                    # or, from a checkout: npm install && npm run build
npx insights-db init
npx insights-db guidance presets/news.json  # optional, from a checkout; installed: node_modules/insights-db/presets/news.json
```

Input is JSON Lines, one document per line. Only `body` is required. [`examples/articles.jsonl`](examples/articles.jsonl) holds three fictional articles: two outlets on a rate rise, then a report of falling mortgage applications.

```json
{"title":"Federal Reserve raises rates by half a point","body":"The Federal Reserve raised its benchmark interest rate by half a percentage point on Wednesday to a range of 5.5 to 5.75 percent, its largest increase this year. Chair Elena Ruiz said …","publishedAt":"2026-08-01T18:00:00Z","source":"Wire One","url":"https://wire.one/federal-reserve-raises-rates-by-half-a-point"}
```

Ingest prints one result per document, in input order:

```sh
$ npx insights-db ingest examples/articles.jsonl --concurrency 4
{"documentId":"1","eventId":"1","outcome":"new","newClaims":7,"newLinks":0,"usage":{"calls":5,"inputTokens":1361,"outputTokens":270,"reasoningTokens":0}}
{"documentId":"2","eventId":"1","outcome":"merged","newClaims":3,"newLinks":0,"usage":{"calls":9,"inputTokens":5761,"outputTokens":651,"reasoningTokens":368}}
{"documentId":"3","eventId":"2","outcome":"new","newClaims":5,"newLinks":1,"usage":{"calls":5,"inputTokens":2714,"outputTokens":326,"reasoningTokens":297}}
```

The second outlet's article was recognised as the same event and contributed three facts the first one lacked (the 10–2 vote, the dissenters' names, Treasury yields); the third created a new event and a `causes` link from the rate rise. Then ask:

```sh
$ npx insights-db ask "Why did mortgage applications fall?"
Mortgage applications fell because the Federal Reserve's half-point rate increase in early August pushed the average 30-year fixed mortgage rate up to 7.4 percent. Applications dropped 12 percent in the week to August 15, with refinancing down 19 percent and purchases down 8 percent — the sharpest weekly fall since 2022, per the Mortgage Lenders Council's chief economist. Council economists expect applications to keep falling through the autumn.

[C1] The Federal Reserve raised its benchmark interest rate by half a percentage point to a range of 5.5 to 5.75 percent.
  Wire One · https://wire.one/federal-reserve-raises-rates-by-half-a-point · 2026-08-01

[C8] Applications for home loans fell 12 percent in the week to August 15, the Mortgage Lenders Council said on Wednesday.
  Wire One · https://wire.one/mortgage-applications-fall-12-percent-after-rate-rise · 2026-08-20

[C9] The average 30-year fixed mortgage rate climbed to 7.4 percent after the Federal Reserve's half-point increase earlier in August 2026.
  Wire One · https://wire.one/mortgage-applications-fall-12-percent-after-rate-rise · 2026-08-20
…
```

The answer is at most 120 words; the citations are built by code from the claim ids the agent used, so a URL never passes through the model. Searches that use no chat model (a text query costs one embedding call):

```sh
$ npx insights-db search "rate rise"
[
  { "eventId": "1", "title": "Federal Reserve raises benchmark interest rate by half a point", "occurredAt": "2026-08-01" },
  { "eventId": "2", "title": "Mortgage applications fall 12 percent after Fed rate rise", "occurredAt": "2026-08-19" }
]
$ npx insights-db similar 2
[
  { "eventId": "1", "title": "Federal Reserve raises benchmark interest rate by half a point", "occurredAt": "2026-08-01",
    "pattern": "central bank raises benchmark interest rate by half a percentage point, with two committee members dissenting", "score": 0.495 }
]
```

## CLI

Every command reads `DATABASE_URL`. JSON output is pretty-printed except `ingest`, which prints one JSON object per line. Only `ingest`, `retry`, `ask` and `relink` call the chat model; `search`, `claims` and `entities` embed the query and run SQL.

| Command | Does |
| --- | --- |
| `init` | Creates or updates the schema. Safe to re-run. |
| `ingest <file.jsonl> [--concurrency 4]` | Ingests one document per line; prints an `IngestResult` per document. |
| `retry [--concurrency 4]` | Re-runs the documents whose last attempt failed, in place. |
| `ask "<question>"` | Runs the query agent; prints the answer, then each cited claim with its source, URL and date. |
| `search "<query>" [--k 8]` | Events by hybrid search (embedding plus full text), titles only. |
| `claims "<query>" [--speculation] [--k 20]` | Single claims matching the query, hidden ones included; `--speculation` limits to speculation. |
| `entities "<query>" [--k 20]` | Entities by name or alias, with how many events each touches. |
| `similar <eventId> [--k 5]` | Events with a similar pattern, best first. No model call. |
| `relink <eventId>` | Re-judges the event's links against events it is not yet connected to. |
| `guidance <file.json>` | Sets owner guidance from `{step: text}`; `null` removes a step's guidance. |

## Library

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

`openInsights` returns an `Insights` handle: a `pg.Pool` (yours or one it opens) plus the functions below as methods. Open several to work with several databases. The same functions are also exported directly (`import { ingest, ask } from 'insights-db'`) and bind to `DATABASE_URL` on first use.

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

## Guidance and presets

The five prompts in `prompts/` are domain-neutral. Owners adapt them without replacing them: `setGuidance(step, text)` stores up to 150 words per step, and every later prompt for that step carries the text in a tagged block the prompt ranks below its own rules. The task text, reply schemas and caps stay fixed, so guidance cannot break parsing. Guidance applies to documents ingested after it is set; nothing is reprocessed.

| Step | Where the text goes |
| --- | --- |
| `domain` | What the documents are. Shown to every write-path prompt and to the query agent. |
| `extract` | What to keep or leave out of an event and its claims. |
| `resolve_entity` | When two names are the same entity. |
| `consolidate` | When two reports are the same event, and which differences are the same fact. |
| `link` | What counts as a relation between events. |
| `query` | How to answer: tone, what to do with disputed claims. |
| `verify` | Reserved for the verification step, which is not built. |

`insights-db guidance <file.json>` calls `setGuidance` for each key in the file. `presets/news.json` is the preset for news articles, which the eval loads:

```json
{
  "domain": "News articles from many outlets. One event is usually reported several times, and wire copy is republished with small edits.",
  "extract": "Leave out the outlet's own analysis and any recap of earlier coverage. Never name the outlet in a title or claim unless the outlet is itself part of the event.",
  "consolidate": "Outlets differ in wording and rounding. \"About 40\" and \"at least 38\" reported on the same day are the same fact unless one is clearly a later count.",
  "query": "When claims are disputed, say that reports differ rather than naming outlets."
}
```

Guidance is stored in the database, so the guidance that built a store travels with it. `getGuidance()` reads it back; `{ "extract": null }` removes a step's guidance.

## Configuration

Three environment variables: `DATABASE_URL` (unless a `connectionString` or `pool` is passed to `openInsights`), `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`. `NODE_DEBUG=insights-db` prints every prompt, reply and token count to stderr.

Everything else is a constant in `src/config.ts`. Nothing there is overridable by environment or options; changing one means editing the file and rebuilding. A changed threshold applies to documents ingested afterwards; existing events are not re-judged.

Provider and models, fixed:

| Constant | Value | Notes |
| --- | --- | --- |
| `LLM_BASE_URL` | `https://api.deepseek.com` | Chat through the `openai` SDK, temperature 0. |
| `LLM_MODEL` | `deepseek-chat` | Extract, resolve entities, consolidate, query. |
| `LLM_MODEL_BY_STEP` | `{ link: 'deepseek-reasoner' }` | The link step; its reasoning tokens are discarded. |
| `EMBED_MODEL`, `EMBED_DIM` | `text-embedding-3-small`, 1536 | OpenAI; DeepSeek has no embedding endpoint. `EMBED_DIM` is baked into the schema. |

Thresholds, tunable by editing the file:

| Constant | Value | Governs |
| --- | --- | --- |
| `SIMHASH_MAX_HAMMING` | 3 | Bits of SimHash difference within which a body is a near duplicate. |
| `NEAR_DUP_WINDOW_DAYS` | 7 | How far apart in document date two near duplicates may be. |
| `ENTITY_NEIGHBOR_MIN` | 0.80 | Name-embedding cosine above which an entity is a candidate for the resolve step. |
| `CANDIDATE_WINDOW_DAYS` | 14 | How recent an event's last activity must be to be a merge candidate. |
| `CANDIDATE_MIN_COSINE` | 0.75 | Content cosine above which an event that shares no entity is still a candidate. |
| `CANDIDATE_MAX` | 5 | Merge candidates shown to the consolidate prompt. |
| `CLAIM_DUP_COSINE` | 0.92 | Claim-embedding cosine above which a new claim is a paraphrase and is dropped. |
| `LINK_WINDOW_DAYS` | 90 | How far back link candidates that share an entity are drawn from. |
| `LINK_CANDIDATE_MAX` | 8 | Link candidates shown to the link prompt. |
| `QUERY_MAX_TOOL_CALLS` | 8 | Tool calls the query agent may make per question. |
| `VERIFY_MODE`, `VERIFY_WEB`, `VERIFY_MAX_SEARCHES`, `VERIFY_REFERENCE_MAX` | `off`, false, 6, 15 | The verification step, which is not built; `VERIFY_MODE` still decides what "hidden" means. |

## Operations

**Cost and latency.** A duplicate costs nothing. Every other document makes one extract call, one embedding call for its claims and one per entity name it has not seen before, a resolve-entity call only when such a name has near neighbours, a consolidate call when candidate events exist, and a link call on the reasoning model when the event is new or gained claims. The three-article run above made 19 calls, about 10 k input and 1.2 k output tokens, in 10 s at concurrency 4; the 96-article eval corpus takes about 200 s at concurrency 4 and about 18 min sequentially. The reasoning model is the slow part and can take a couple of minutes on a large candidate set. Each `IngestResult` carries its own `usage`; the `insights-db:llm` diagnostics channel publishes every call.

**Failures.** A document is failed when `documents.error` is set. A failure before the write (extract, resolve, consolidate, or the model returning an invalid reply twice) leaves only the document row, with `eventId: null` and `outcome: 'failed'`. A failure in the link step keeps the event and its claims and records `link: <message>` in `error`; the result still says `new` or `merged`, with `newLinks: 0`. Transient provider errors are retried five times with backoff inside the SDK before either counts as a failure, and a call times out after 180 s. A failed document is not an original for the dedup gate, so it can be re-ingested.

**Retry.** `retryFailed()` or `insights-db retry` re-runs failed documents in place: the whole pipeline for a document with no event, only the link step for one that has an event. Run it after a provider outage or a rate-limit storm.

**Relink.** Links are judged when an event is created and again when it gains claims in a merge, against events it is not yet connected to. `relink(eventId)` or `insights-db relink <id>` forces that judgment, for example after ingesting older background documents. An event never leaves its storyline on a re-run.

**Wrong merges.** `detachDocument(documentId)` removes the document's claims from the event it joined, clears pointers to them, and re-ingests it with that event excluded from the candidates. If the old event is left with no claims and no documents it is deleted along with its links, and its storyline goes when one event remains. Merge precision is weighted above recall on purpose: a missed merge leaves two events a link can connect, a wrong merge mixes facts.

**Wrong entities.** `mergeEntities(keepId, dropId)` when the resolver made two of one thing; the dropped name and aliases become aliases of the kept entity.

**Schema.** `db/schema.sql` is idempotent and `init()` applies it; a version that changes the schema says so in [CHANGELOG.md](CHANGELOG.md), and `init` after upgrading applies the change.

## Development

```sh
npm install
npm test                 # vitest with a fake LLM; needs DATABASE_URL (defaults to the container above)
npm run typecheck
npm run build            # dist/
npm run eval             # live models against an empty database; eval/set.json (104 articles, 32 events)
npm run eval -- eval/set2.json   # second corpus, non-financial domains
```

Tests replay fixture replies through a fake `openai` client, so they are deterministic and need no keys. The eval ingests a labeled fictional corpus with live models, prints merge, link and storyline precision, redundancy, questions answered and mean output tokens per step, and exits non-zero when a target in the [design doc](docs/design.md#milestone-6-eval) is missed; it refuses a database that already holds documents.

Source files import with `.ts` specifiers, so `eval/run.ts` runs on Node's type stripping with no build step. Prompts live in `prompts/`, one file per step plus `shared.md`; changing one is a behaviour change and should be run through the eval.

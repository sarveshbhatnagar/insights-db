# Changelog

Dates are release dates. Decisions behind each change are in [DECISIONS.md](DECISIONS.md).

## 0.3.2 — 2026-09-20

- Documentation: README rewritten as a short entry point, with concepts, quickstart, CLI, library and read API, guidance, configuration and operations under `docs/`, which now ships in the package along with this changelog. The design doc moves to `docs/design.md`.

## 0.3.1 — 2026-09-20

- `storylineId` (one id or several) joins the read filters, so `events.list`, `events.similar` and the `events.entities` catalog can be limited to a storyline.

## 0.3.0 — 2026-09-20

Opens the store to a second system that keeps its own context per event and reads events from here.

- `openInsights({ connectionString | pool })` returns an `Insights` handle with every public function as a method. Several databases can be open at once, and a caller can hand in its own `pg.Pool`. The direct exports (`ingest`, `ask`, …) still work and bind to `DATABASE_URL` on first use.
- Read API under `db.events`, no LLM calls: `getMany(ids, { asOf })`, `list(filters + limit, cursor, order)` with a keyset cursor on `(occurredAt, id)`, `similar({ eventId | embedding, k, minScore, filters }, 'pattern' | 'content')`, and the `types()` and `entities()` catalogs with counts and date spans.
- Every event record carries `observedAt`, the earliest of its documents' dates. `asOf` returns only events observed by then, as they stood then: claims asserted by `asOf`, and a supersession counted only once the superseding claim was itself asserted.
- **Breaking:** `getEvent(id, includeHistory)` is now `getEvent(id, { includeHistory, asOf })`.
- `similarEvents` and the query agent's `find_similar` go through `events.similar`.

## 0.2.0 — 2026-09-20

Operations the v1 design left out.

- `ingestMany(docs, { concurrency })` and `insights-db ingest --concurrency`: the dedup gate runs for every document in order under a Postgres advisory lock, so a repeat inside a batch is a duplicate of the first copy; the LLM steps run concurrently, and the write re-checks the candidate events under the lock. 96 articles take about 200 s at concurrency 4 against about 18 min sequentially.
- `retryFailed()` and `insights-db retry` re-run failed documents in place. A failure in the link step now keeps the event and records `link: …` in the document's `error` instead of failing the document.
- `init()` and `insights-db init` apply `db/schema.sql`, which is idempotent; migrations append to the same file.
- `relink(eventId)` and `insights-db relink`: an event that gains claims in a merge is re-judged for links against events it is not yet connected to. No LLM call when there is nothing new to judge.
- `searchEvents`, `listClaims`, `listEntities` exported, with the `search`, `claims` and `entities` commands; the query agent gains the `search_claims` tool.
- Every `IngestResult` carries its LLM `usage` (calls and input, output and reasoning tokens).
- Model calls retry transient errors five times with backoff and time out after 180 s.

## 0.1.0 — 2026-09-20

First release, built to the [design doc](docs/design.md).

- Ingest pipeline: dedup gate (sha256 and SimHash), extract, resolve entities, find candidate events, consolidate, write, link and storyline.
- `ask` runs a tool-using query agent and returns an answer with citations built by code.
- `similarEvents`, `getEvent`, `getStoryline`, `setGuidance`, `getGuidance`, `mergeEntities`, `detachDocument`.
- CLI: `ingest`, `ask`, `similar`, `guidance`. The news preset in `presets/news.json`.
- DeepSeek (`deepseek-chat`, and `deepseek-reasoner` for the link step) through the `openai` SDK; OpenAI `text-embedding-3-small` for embeddings. Chat calls run at temperature 0.
- Eval against two labeled fictional corpora (`eval/set.json`, `eval/set2.json`) with live models.

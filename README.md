# insights-db

TypeScript library and CLI that ingests documents, stores each real-world event once with its facts, links related events, and answers questions over the result. The design doc is the spec; `DECISIONS.md` lists choices made where it is silent.

## Requirements

- Node 22+
- Postgres 16 with the pgvector extension. Any host works: local install, container, or managed (Neon, Supabase, RDS).
- `DEEPSEEK_API_KEY` (chat) and `OPENAI_API_KEY` (embeddings)

Where the data lives is Postgres's choice: put the cluster's data directory on the disk you want (`initdb -D /Volumes/ssd/pgdata`) or give the database a tablespace there. The library only needs `DATABASE_URL`.

A throwaway database for development:

    docker run -d --name insights-db-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=insights_db -p 5433:5432 pgvector/pgvector:pg16
    export DATABASE_URL=postgres://postgres:postgres@localhost:5433/insights_db

## Install and run

    npm install insights-db                 # or, from a checkout: npm install && npm run build
    npx insights-db init                    # creates or updates the schema; safe to re-run
    npx insights-db guidance presets/news.json           # optional owner guidance
    npx insights-db ingest articles.jsonl --concurrency 4   # one {body, title?, publishedAt?, source?, url?} per line
    npx insights-db retry                   # re-run documents that failed
    npx insights-db ask "Why did mortgage applications fall?"
    npx insights-db search "bank failure"   # events, no LLM;  claims "<q>" [--speculation];  entities "<q>"
    npx insights-db similar <eventId>       # analogous events by pattern;  relink <eventId> re-judges links

Library: `const db = openInsights({ connectionString })` (or `{ pool }`; defaults to `DATABASE_URL`) gives a handle with `init, ingest, ingestMany, retryFailed, ask, searchEvents, listClaims, listEntities, similarEvents, getEvent, getStoryline, relink, setGuidance, getGuidance, mergeEntities, detachDocument, end`. The same functions are also exported directly and run against `DATABASE_URL`. Every ingest result carries its LLM `usage`. Set `NODE_DEBUG=insights-db` to trace prompts and replies.

Read API, no LLM, for a system that keeps its own context per event: `db.events.getMany(ids, { asOf? })`, `db.events.list({ eventType?, entityIds?, from?, to?, asOf?, excludeIds?, storylineId?, limit?, cursor?, order? })` (keyset page on `occurredAt, id`), `db.events.similar({ eventId | embedding, k?, minScore?, filters? }, 'pattern' | 'content')` (`filters` takes the same keys as `list`), `db.events.types()`, `db.events.entities({ eventType?, from?, to?, storylineId?, limit? })`. Each record carries `occurredAt` (the event's calendar day, `YYYY-MM-DD`, read it as 00:00 UTC) and `observedAt` (the earliest of its documents' dates). `asOf` returns only events observed by then, as they stood then: claims asserted by `asOf`, a supersession counted only once the superseding claim was asserted. `getEvent(id, { asOf })` does the same. Events are never deleted in cascade with another store; `getMany` returns only the ids that exist, so sweep with it.

## Test and eval

    npm test                 # fake LLM, needs DATABASE_URL (defaults to the container above)
    npm run typecheck
    npm run eval             # live models, empty database; labeled sets in eval/set.json and eval/set2.json

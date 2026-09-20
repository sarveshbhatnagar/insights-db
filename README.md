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

## Setup

    npm install
    sed "s/EMBED_DIM/1536/" db/schema.sql | psql "$DATABASE_URL"   # or applySchema() from src/db.ts
    npm run build

## Run

    npx insights-db guidance presets/news.json      # optional owner guidance
    npx insights-db ingest articles.jsonl           # one {body, title?, publishedAt?, source?, url?} per line
    npx insights-db ask "Why did mortgage applications fall?"
    npx insights-db similar <eventId> --k 5

Library: `import { ingest, ask, similarEvents, getEvent, getStoryline, setGuidance, getGuidance, mergeEntities, detachDocument } from 'insights-db'`.

## Test and eval

    npm test                 # fake LLM, needs DATABASE_URL (defaults to the container above)
    npm run typecheck
    npm run eval             # live models, empty database; labeled set in eval/set.json, format in eval/run.ts

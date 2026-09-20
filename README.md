# insights-db

TypeScript library and CLI that ingests documents, stores each real-world event once with its facts, links related events, and answers questions over the result. One Postgres database with pgvector, one LLM provider, no server.

Each document is reduced to the one event it reports and the facts it asserts; a second report of the same event adds only what the store lacked. Events that bear on each other get typed links (`causes`, `reacts_to`, `contradicts`, `background_for`) and can share a storyline. A question is answered by an agent that reads the store and cites the claims it used. Terms are defined in [docs/concepts.md](docs/concepts.md).

## Quickstart

Node 22+, Postgres 16 with pgvector, `DEEPSEEK_API_KEY` (chat) and `OPENAI_API_KEY` (embeddings). A throwaway database:

    docker run -d --name insights-db-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=insights_db -p 5433:5432 pgvector/pgvector:pg16
    export DATABASE_URL=postgres://postgres:postgres@localhost:5433/insights_db

    npm install insights-db                     # or, from a checkout: npm install && npm run build
    npx insights-db init                        # creates or updates the schema; safe to re-run
    npx insights-db guidance presets/news.json  # optional: tune the prompts for news
    npx insights-db ingest examples/articles.jsonl --concurrency 4   # one {body, title?, publishedAt?, source?, url?} per line
    npx insights-db ask "Why did mortgage applications fall?"

`ingest` prints one line per document (`outcome` is `new`, `merged`, `duplicate` or `failed`, with its LLM usage); `ask` prints the answer and a citation per claim it used. Full output and the other commands are in [docs/quickstart.md](docs/quickstart.md).

```ts
import { openInsights } from 'insights-db';
const db = openInsights({ connectionString: process.env.DATABASE_URL });
await db.ingestMany(docs, { concurrency: 4 });
const { answer, citations } = await db.ask('Why did mortgage applications fall?');
const page = await db.events.list({ from: '2026-08-01', asOf: '2026-08-10' });   // read API, no LLM
```

## Documentation

- [Concepts](docs/concepts.md): document, event, claim, supersession, hidden claim, entity, link, storyline, `occurredAt` vs `observedAt`
- [Quickstart](docs/quickstart.md): the commands above with real output
- [CLI](docs/cli.md) and [Library](docs/library.md): every command, method, exported type and the `db.events` read API
- [Guidance and presets](docs/guidance.md): adapting the prompts per step; `presets/news.json`
- [Configuration](docs/configuration.md): environment variables, the fixed provider, every threshold in `config.ts`
- [Operations](docs/operations.md): cost and latency, what "failed" means, `retry`, `relink`, `detachDocument`, `mergeEntities`
- [Design doc](docs/design.md) is the spec; [DECISIONS.md](DECISIONS.md) records choices made where it is silent; [CHANGELOG.md](CHANGELOG.md)

## Development

    npm test                 # fake LLM, needs DATABASE_URL (defaults to the container above)
    npm run typecheck
    npm run eval             # live models, empty database; eval/set.json and eval/set2.json

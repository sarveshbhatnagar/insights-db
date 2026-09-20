# Quickstart

Requirements: Node 22+, Postgres 16 with the pgvector extension (local, container or managed: Neon, Supabase, RDS all work), a `DEEPSEEK_API_KEY` for chat and an `OPENAI_API_KEY` for embeddings. The provider pairing is fixed, see [Configuration](configuration.md).

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

Input is JSON Lines, one document per line. Only `body` is required. [`examples/articles.jsonl`](../examples/articles.jsonl) holds three fictional articles: two outlets on a rate rise, then a report of falling mortgage applications.

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

The other commands are in [cli.md](cli.md); the same run as a script, and the read API, in [library.md](library.md).

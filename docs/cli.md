# CLI

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

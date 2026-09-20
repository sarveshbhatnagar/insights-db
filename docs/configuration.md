# Configuration

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

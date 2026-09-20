# Operations

**Cost and latency.** A duplicate costs nothing. Every other document makes one extract call, one embedding call for its claims and one per entity name it has not seen before, a resolve-entity call only when such a name has near neighbours, a consolidate call when candidate events exist, and a link call on the reasoning model when the event is new or gained claims. The three-article run in the [quickstart](quickstart.md) made 19 calls, about 10 k input and 1.2 k output tokens, in 10 s at concurrency 4; the 96-article eval corpus takes about 200 s at concurrency 4 and about 18 min sequentially. The reasoning model is the slow part and can take a couple of minutes on a large candidate set. Each `IngestResult` carries its own `usage`; the `insights-db:llm` diagnostics channel publishes every call.

**Failures.** A document is failed when `documents.error` is set. A failure before the write (extract, resolve, consolidate, or the model returning an invalid reply twice) leaves only the document row, with `eventId: null` and `outcome: 'failed'`. A failure in the link step keeps the event and its claims and records `link: <message>` in `error`; the result still says `new` or `merged`, with `newLinks: 0`. Transient provider errors are retried five times with backoff inside the SDK before either counts as a failure, and a call times out after 180 s. A failed document is not an original for the dedup gate, so it can be re-ingested.

**Retry.** `retryFailed()` or `insights-db retry` re-runs failed documents in place: the whole pipeline for a document with no event, only the link step for one that has an event. Run it after a provider outage or a rate-limit storm.

**Relink.** Links are judged when an event is created and again when it gains claims in a merge, against events it is not yet connected to. `relink(eventId)` or `insights-db relink <id>` forces that judgment, for example after ingesting older background documents. An event never leaves its storyline on a re-run.

**Wrong merges.** `detachDocument(documentId)` removes the document's claims from the event it joined, clears pointers to them, and re-ingests it with that event excluded from the candidates. If the old event is left with no claims and no documents it is deleted along with its links, and its storyline goes when one event remains. Merge precision is weighted above recall on purpose: a missed merge leaves two events a link can connect, a wrong merge mixes facts.

**Wrong entities.** `mergeEntities(keepId, dropId)` when the resolver made two of one thing; the dropped name and aliases become aliases of the kept entity.

**Schema.** `db/schema.sql` is idempotent and `init()` applies it; a version that changes the schema says so in [CHANGELOG.md](../CHANGELOG.md), and `init` after upgrading applies the change.

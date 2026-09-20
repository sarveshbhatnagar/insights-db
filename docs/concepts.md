# Concepts

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
| **Document** | What you ingest: a `body` and, optionally, `title`, `publishedAt`, `source`, `url`. Stored as given and never edited or deleted. Every document ends up in one of four states: `duplicate` (exact or near copy of a stored document, no LLM call), `new` (created an event), `merged` (added to an existing event), `failed` (see [Operations](operations.md)). |
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

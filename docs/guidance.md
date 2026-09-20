# Guidance and presets

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

Task: read one document and return the single main event it reports. An event is
one real-world occurrence: something that happened, was decided, was found or was announced.

<document source="{source}" date="{document_date}">
{title}

{body}
</document>

Reply schema:
{
  "title": string,          // <= 15 words. What happened. No source names.
  "event_type": string,     // snake_case, 1-3 words, e.g. "bank_failure", "product_recall"
  "pattern": string,        // <= 25 words. See below.
  "occurred_at": "YYYY-MM-DD", // when it happened; the document's date above if the text does not say.
                            // For an announcement, report, ruling, finding or disclosure, the date it
                            // was made public, not the date of what it describes.
  "entities": [             // <= 8, only those central to the event
    { "name": string, "type": "person"|"org"|"place"|"other", "role": string }  // role <= 3 words
  ],
  "claims": [ string ],     // <= 10
  "speculation": [ string ] // <= 5, usually empty. See below.
}

Pattern: describe the event with every name, place, date and number replaced by a generic description, for example "mid-size bank fails after deposit run triggered by bond losses". It is used to find analogous events elsewhere, so it must still make sense for a different event of the same kind.

Claims:
- One checkable fact per claim, <= 30 words, understandable on its own: use names, not "he" or "the company".
- Keep figures, dates, decisions, direct consequences, and attributed statements
  ("X said Y").
- A claim states something that has happened or is the case. Forecasts,
  hypotheticals, extrapolations ("if this continues, X will...") and promotional
  superlatives ("set to dominate the market") are not claims. Put each one in
  "speculation" instead: <= 30 words, understandable on its own, naming who made
  it when the document says. It is stored apart from facts so it can be found and
  checked, and is never presented as fact.
- Attribution does not turn a forecast into a claim. "Analysts estimated the repair
  would cost 300 million" and "X said sales could reach 10 billion" are speculation;
  "X said the toll was 40" is a claim. A prediction about what will happen is
  speculation whoever makes it; a decision, measurement or figure about what has
  already happened is a claim.
- Leave out opinion, colour, and background about earlier events. Earlier events
  have their own records.
- No two claims may state the same fact in different words. If the document
  repeats itself, you do not.
- Use the full name of each entity on first mention, as it appears in "entities".

<owner_guidance>
{guidance}
</owner_guidance>

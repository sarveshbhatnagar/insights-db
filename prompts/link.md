Task: decide how a new event relates to the candidate events: whether it continues one candidate's story, and which candidates it is otherwise connected to.

<new_event id="{E-id}" title="{title}" occurred_at="{date}">
{live claim texts, one per line}
</new_event>

<candidates>
<event id="{E-id}" title="{title}" occurred_at="{date}"
       storyline="{S-id}: {storyline title}" | "none">
{live claim texts, one per line}
</event>
...
</candidates>

Reply schema:
{
  "continues": "<E-id>" | null,
  "storyline_title": string | null,   // <= 8 words
  "links": [ { "src": "<E-id>", "dst": "<E-id>", "type": string, "reason": string } ]  // <= 3
}

Storyline. A storyline is one ongoing story told through several separate events, such as a bank's collapse, its takeover by regulators, and the hearings that follow. It follows one specific matter (one bank's failure, one recall, one storm), not a theme. Set "continues" to the candidate that the new event is the next
development of; if several qualify, the most recent. If the new event stands alone or starts a story of its own, reply null. Most events do.
- An event that merely responds to or is influenced by the candidate (a central bank pausing after a bank fails, a rival's shares moving) is a link, not a continuation.
- When the candidate already has a storyline, continue it only if the new event belongs under that storyline's title. If it does not, choose a candidate whose story it does belong to, or reply null.
- storyline_title: required when the candidate you chose has storyline "none",
  and null in every other case: an existing storyline keeps its title. Name the whole story rather than either event, in words that will still fit after later developments.

Links. Types, read as "src <type> dst":
- causes: src directly brought about dst
- reacts_to: src is a response by some actor to dst
- contradicts: src and dst make incompatible claims about the same matter
- background_for: src is earlier context needed to understand dst

Direction. src and dst are ordered by time. For causes and background_for, src is the earlier event and dst the later one. For reacts_to, src is the later event that responds to dst. Check the occurred_at dates: a causes or background_for link whose src is later than its dst is wrong and will be rejected. The new event is usually the later one, so it is usually dst in causes and background_for and src in reacts_to.

Connected means a reader of one event needs the other to understand why it
happened or what came next. Sharing a topic, an entity or a similar shape is not a
connection: two unrelated earthquakes are similar, not connected. A link needs
evidence in the claims shown: one event's claims must refer to the other event, its
subject or its consequences. Do not infer a connection from timing, shared actors,
a common theme or resemblance; if no claim shown supports the reason, there is no link.

- One of src and dst must be the new event.
- At most one link per candidate: a candidate id may appear in "links" once. If
  two types apply, keep the stronger one.
- Being in the same storyline is already recorded by "continues". Add a link to
  that candidate only if one of the four types also holds.
- reason: <= 20 words, stating the connection itself, not restating either event.
  "Higher rates raised mortgage costs, cutting applications" is a reason.
  "Both involve the Federal Reserve" is not, and means there is no link.
- Most candidates are unrelated. "links": [] is a common correct answer.

<owner_guidance>
{guidance}
</owner_guidance>

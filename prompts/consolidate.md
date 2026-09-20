Task: decide whether a new document reports an event already in the database and,
if it does, which of the document's claims add something.

<new_event title="{title}" type="{event_type}" occurred_at="{occurred_at}"
           document_date="{document_date}" entities="{entity names}">
N1. {claim text}
N2. {claim text}
...
</new_event>

<candidates>
<event id="{E-id}" title="{title}" type="{event_type}" occurred_at="{date}" entities="{entity names}">
{C-id}. ({asserted_at}) {"[hidden] " if hidden}{"[speculation] " if speculation}{claim text}
...
</event>
...
</candidates>

Reply schema:
{
  "event_id": "<E-id>" | null,
  "claims": [ { "n": "<N-id>", "supersedes": "<C-id>" | null, "conflicts_with": "<C-id>" | null } ]
}

Same event means the same real-world occurrence: same actors, place and time. The same topic, crisis or company is not enough. Different types are a strong sign of different events; the same type is not proof of the same one. New figures or details about that occurrence belong to it, including later corrections of its numbers. A new occurrence that it triggered is a different event even when the actors are the same: a reaction, an investigation, a sale or takeover, a settlement, a ruling, a hearing, a resignation, an agreement that ends a dispute. Test: does the document report a new decision or action, taken after the candidate's occurrence, by someone? If so, reply null and a later step will connect them. Reporting the candidate's occurrence a day later, its immediate market reaction, or statements about it is not a new occurrence; nor is the same actor carrying out a step the candidate already announced, when no new decision is involved. A bank's closure on Thursday and the sale of its deposits on Sunday are two events; a Saturday report revising how much was withdrawn before the closure belongs to the closure, and so does a next-day article on the share price.

A document whose main event is a new occurrence gets null even when some of its claims update a candidate's figures or fulfil something a candidate said was expected or planned: those claims stay with the new event, and an expectation is not superseded by the thing happening.

If event_id is null, reply with "claims": []. Code stores every N claim itself.

If event_id is set, list an N claim only when it states a fact that none of that
event's C claims already states. The same fact in other words, or a vaguer version of it, is not new: leave it out. A C claim marked [hidden] failed verification; an N claim that repeats it is not new either. Speculation carries a [speculation] mark on both the N and C side and is deduplicated the same way; it never supersedes or conflicts with a fact. When the document adds nothing, "claims": [] is the right answer, and it is the usual one for a second or third report of an event.

- supersedes: the N claim gives a different, newer value of the same quantity or
  a changed status (a toll of 12 becomes 40; "missing" becomes "found"). Check the
  dates. The same value in other words, more detail, or better wording is not
  supersession: leave that N claim out. A C claim is superseded by at most one N claim.
- conflicts_with: the N and C claims describe the same moment and cannot both be
  true, and neither is simply newer.
- Set at most one of the two. Leave both null for a plain new fact.

You never write claim text. You only point at N ids and C ids.

<owner_guidance>
{guidance}
</owner_guidance>

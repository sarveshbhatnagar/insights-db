import { z } from 'zod';
import { LINK_CANDIDATE_MAX, LINK_WINDOW_DAYS } from './config.ts';
import { type Db, liveClaim } from './db.ts';
import { completeJson } from './llm.ts';
import { idEnum, maxWords, pid, render, unpid } from './prompts.ts';

export const LINK_TYPES = ['causes', 'reacts_to', 'contradicts', 'background_for'] as const;

type EventView = {
  id: string;
  title: string;
  occurred_at: string;
  storyline_id: string | null;
  storyline_title: string | null;
  claims: string[];
};

async function loadEvents(db: Db, ids: string[]): Promise<EventView[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<EventView>(
    `select e.id, e.title, e.occurred_at, e.storyline_id, s.title as storyline_title,
            array(select c.text from claims c where c.event_id = e.id and ${liveClaim('c')}
                  order by c.asserted_at, c.id) as claims
     from events e left join storylines s on s.id = e.storyline_id
     where e.id = any($1::bigint[])`,
    [ids],
  );
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

// Step 7. Returns the number of links inserted.
export async function linkEvent(db: Db, eventId: string, rejected: string[]): Promise<number> {
  const related = await db.query<{ id: string }>(
    `(select e.id from events e
      where e.id <> $1
        and e.occurred_at between (select occurred_at from events where id = $1) - $2::int
                              and (select occurred_at from events where id = $1) + $2::int
        and exists (select 1 from event_entities a join event_entities b on a.entity_id = b.entity_id
                    where a.event_id = $1 and b.event_id = e.id)
      order by e.occurred_at desc limit $3)
     union all
     (select e.id from events e where e.id <> $1
      order by e.content_embedding <=> (select content_embedding from events where id = $1) limit $3)`,
    [eventId, LINK_WINDOW_DAYS, LINK_CANDIDATE_MAX],
  );
  const candidateIds = [...new Set([...rejected.filter((id) => id !== eventId), ...related.rows.map((r) => r.id)])].slice(
    0,
    LINK_CANDIDATE_MAX,
  );
  if (candidateIds.length === 0) return 0;

  const [event, ...candidates] = await loadEvents(db, [eventId, ...candidateIds]);
  const newId = pid('E', eventId);
  const user = await render('link', {
    'E-id': newId,
    title: event!.title,
    date: event!.occurred_at,
    new_claims: event!.claims.join('\n'),
    candidates: candidates
      .map(
        (c) =>
          `<event id="${pid('E', c.id)}" title="${c.title}" occurred_at="${c.occurred_at}"\n` +
          `       storyline="${c.storyline_id ? `${pid('S', c.storyline_id)}: ${c.storyline_title}` : 'none'}">\n` +
          `${c.claims.join('\n')}\n</event>`,
      )
      .join('\n'),
  });

  const cids = candidates.map((c) => pid('E', c.id));
  const storylineOf = new Map(candidates.map((c) => [pid('E', c.id), c.storyline_id]));
  const dateOf = new Map([event!, ...candidates].map((c) => [pid('E', c.id), c.occurred_at]));
  const anyId = idEnum([newId, ...cids]);
  // Causal and background links run forward in time, reactions backward.
  const inOrder = (l: { src: string; dst: string; type: string }): boolean =>
    l.type === 'contradicts' ||
    (l.type === 'reacts_to' ? dateOf.get(l.src)! >= dateOf.get(l.dst)! : dateOf.get(l.src)! <= dateOf.get(l.dst)!);
  const schema = z
    .strictObject({
      continues: idEnum(cids).nullable(),
      storyline_title: maxWords(8).nullable(),
      links: z
        .array(
          z
            .strictObject({ src: anyId, dst: anyId, type: z.enum(LINK_TYPES), reason: maxWords(20) })
            .refine((l) => l.src !== l.dst && (l.src === newId || l.dst === newId), 'one of src and dst must be the new event')
            .refine(inOrder, 'causes and background_for run from the earlier event to the later one; reacts_to from the later to the earlier'),
        )
        .max(3)
        .refine((links) => new Set(links.map((l) => (l.src === newId ? l.dst : l.src))).size === links.length, 'at most one link per candidate'),
    })
    .refine((r) => r.continues !== null || r.storyline_title === null, {
      message: 'storyline_title must be null when continues is null: a new event never starts a storyline by itself',
    })
    .refine((r) => r.continues === null || storylineOf.get(r.continues) === null || r.storyline_title === null, {
      message: 'storyline_title must be null: the continued candidate already has a storyline',
    })
    .refine((r) => r.continues === null || storylineOf.get(r.continues) !== null || r.storyline_title !== null, {
      message: 'storyline_title is required: the continued candidate has no storyline',
    });
  const reply = await completeJson(await render('shared'), user, schema);

  let inserted = 0;
  for (const link of reply.links) {
    const res = await db.query(
      `insert into links (src, dst, type, reason)
       select $1, $2, $3, $4
       where not exists (select 1 from links where (src, dst) in (($1, $2), ($2, $1)))`,
      [unpid(link.src), unpid(link.dst), link.type, link.reason],
    );
    inserted += res.rowCount ?? 0;
  }
  if (reply.continues) {
    const continued = unpid(reply.continues);
    if (storylineOf.get(reply.continues)) {
      await db.query('update events set storyline_id = $2 where id = $1', [eventId, storylineOf.get(reply.continues)]);
    } else {
      const s = await db.query<{ id: string }>('insert into storylines (title) values ($1) returning id', [reply.storyline_title]);
      await db.query('update events set storyline_id = $1 where id = any($2::bigint[])', [s.rows[0]!.id, [eventId, continued]]);
    }
  }
  return inserted;
}

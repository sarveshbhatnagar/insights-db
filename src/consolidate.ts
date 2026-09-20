import { z } from 'zod';
import { CANDIDATE_MAX, CANDIDATE_MIN_COSINE, CANDIDATE_WINDOW_DAYS } from './config.ts';
import { type Connection, type Db, hiddenClaim, vec } from './db.ts';
import type { Extraction } from './extract.ts';
import { completeJson } from './llm.ts';
import { idEnum, isoDate, pid, render } from './prompts.ts';

export type NewClaim = { n: string; text: string; kind: 'fact' | 'speculation' };

export type Candidate = {
  id: string;
  title: string;
  eventType: string;
  occurredAt: string;
  entities: string[];
  claims: { id: string; text: string; assertedAt: Date; kind: 'fact' | 'speculation'; hidden: boolean }[];
};

export async function findCandidates(
  db: Db,
  opts: { documentDate: Date; entityIds: string[]; embedding: number[]; exclude?: string | undefined },
): Promise<Candidate[]> {
  const events = await db.query<{ id: string; title: string; event_type: string; occurred_at: string; entities: string[] }>(
    `with activity as (select event_id, max(asserted_at) as last from claims group by event_id)
     select e.id, e.title, e.event_type, e.occurred_at,
            array(select n.name from event_entities ee join entities n on n.id = ee.entity_id
                  where ee.event_id = e.id order by n.id) as entities
     from events e join activity a on a.event_id = e.id
     where a.last between $1::timestamptz - $2 * interval '1 day' and $1::timestamptz + $2 * interval '1 day'
       and (e.id in (select event_id from event_entities where entity_id = any($3::bigint[]))
            or 1 - (e.content_embedding <=> $4::vector) >= $5)
       and ($6::bigint is null or e.id <> $6)
     order by e.content_embedding <=> $4::vector
     limit $7`,
    [opts.documentDate, CANDIDATE_WINDOW_DAYS, opts.entityIds, vec(opts.embedding), CANDIDATE_MIN_COSINE, opts.exclude ?? null, CANDIDATE_MAX],
  );
  if (events.rows.length === 0) return [];
  // Superseded claims stay out: the agent must point at current facts.
  const claims = await db.query<{
    id: string; event_id: string; text: string; asserted_at: Date; kind: 'fact' | 'speculation'; hidden: boolean;
  }>(
    `select c.id, c.event_id, c.text, c.asserted_at, c.kind, (${hiddenClaim('c')}) as hidden
     from claims c where c.event_id = any($1::bigint[]) and c.superseded_by is null
     order by c.asserted_at, c.id`,
    [events.rows.map((e) => e.id)],
  );
  return events.rows.map((e) => ({
    id: e.id,
    title: e.title,
    eventType: e.event_type,
    occurredAt: e.occurred_at,
    entities: e.entities,
    claims: claims.rows
      .filter((c) => c.event_id === e.id)
      .map((c) => ({ id: c.id, text: c.text, assertedAt: c.asserted_at, kind: c.kind, hidden: c.hidden })),
  }));
}

export type ConsolidateReply = {
  event_id: string | null;
  claims: { n: string; supersedes: string | null; conflicts_with: string | null }[];
};

export async function consolidate(
  conn: Connection,
  extraction: Extraction,
  entityNames: string[],
  documentDate: Date,
  newClaims: NewClaim[],
  candidates: Candidate[],
): Promise<ConsolidateReply> {
  const user = await render(conn, 'consolidate', {
    title: extraction.title,
    event_type: extraction.event_type,
    occurred_at: extraction.occurred_at,
    document_date: isoDate(documentDate),
    'entity names': entityNames.join(', '),
    new_claims: newClaims.map((c) => `${c.n}. ${c.kind === 'speculation' ? '[speculation] ' : ''}${c.text}`).join('\n'),
    candidates: candidates
      .map(
        (e) =>
          `<event id="${pid('E', e.id)}" title="${e.title}" type="${e.eventType}" occurred_at="${e.occurredAt}" entities="${e.entities.join(', ')}">\n` +
          e.claims
            .map(
              (c) =>
                `${pid('C', c.id)}. (${isoDate(c.assertedAt)}) ${c.hidden ? '[hidden] ' : ''}${c.kind === 'speculation' ? '[speculation] ' : ''}${c.text}`,
            )
            .join('\n') +
          '\n</event>',
      )
      .join('\n'),
  });

  const claimOwner = new Map<string, { event: string; kind: string }>();
  for (const e of candidates) for (const c of e.claims) claimOwner.set(pid('C', c.id), { event: pid('E', e.id), kind: c.kind });
  const kindOf = new Map(newClaims.map((c) => [c.n, c.kind]));
  const cid = idEnum([...claimOwner.keys()]).nullable();
  const schema = z
    .strictObject({
      event_id: idEnum(candidates.map((e) => pid('E', e.id))).nullable(),
      claims: z
        .array(
          z
            .strictObject({ n: idEnum(newClaims.map((c) => c.n)), supersedes: cid, conflicts_with: cid })
            .refine((c) => !(c.supersedes && c.conflicts_with), 'set at most one of supersedes and conflicts_with'),
        )
        .max(newClaims.length),
    })
    .refine((r) => r.event_id !== null || r.claims.length === 0, 'claims must be [] when event_id is null')
    .refine((r) => new Set(r.claims.map((c) => c.n)).size === r.claims.length, 'each N id at most once')
    .refine((r) => {
      const targets = r.claims.map((c) => c.supersedes).filter(Boolean);
      return new Set(targets).size === targets.length;
    }, 'a C claim is superseded by at most one N claim')
    .refine(
      (r) =>
        r.claims.every((c) => {
          const target = c.supersedes ?? c.conflicts_with;
          if (!target) return true;
          const owner = claimOwner.get(target)!;
          return owner.event === r.event_id && (kindOf.get(c.n) !== 'speculation' || owner.kind === 'speculation');
        }),
      'supersedes and conflicts_with must point at a claim of the chosen event, and speculation only at speculation',
    );
  return completeJson(await render(conn, 'shared'), user, schema);
}

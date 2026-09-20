import { z } from 'zod';
import { QUERY_MAX_TOOL_CALLS } from './config.ts';
import { documentDate, hiddenClaim, liveClaim, pool, vec } from './db.ts';
import { LINK_TYPES } from './link.ts';
import { embed, runTools, type Tool } from './llm.ts';
import { maxWords, pid, render, unpid } from './prompts.ts';

export type Claim = {
  claimId: string;
  text: string;
  assertedAt: Date;
  kind: 'fact' | 'speculation';
  disputedWith: string[];
  verdict: 'refuted' | 'unsupported' | null;
  evidenceUrl: string | null;
  supersededBy: string | null;
  hidden: boolean;
};

export type EventDetail = {
  eventId: string;
  title: string;
  eventType: string;
  pattern: string;
  occurredAt: string;
  storyline: { storylineId: string; title: string } | null;
  entities: { entityId: string; name: string; type: string; role: string }[];
  claims: Claim[];
  speculation: Claim[];
  links: { eventId: string; title: string; type: string; direction: 'out' | 'in'; reason: string }[];
  documents: { documentId: string; title: string | null; source: string | null; url: string | null; publishedAt: Date }[];
};

// Tool arguments may carry the prompt prefix (E17) or not (17).
const rawId = (s: string): string => (/^[A-Z]\d+$/.test(s) ? unpid(s) : s);

export async function getEvent(eventId: string, includeHistory = false): Promise<EventDetail> {
  const event = await pool.query<{
    id: string; title: string; event_type: string; pattern: string; occurred_at: string;
    storyline_id: string | null; storyline_title: string | null;
  }>(
    `select e.id, e.title, e.event_type, e.pattern, e.occurred_at, e.storyline_id, s.title as storyline_title
     from events e left join storylines s on s.id = e.storyline_id where e.id = $1`,
    [eventId],
  );
  const e = event.rows[0];
  if (!e) throw new Error(`no event ${eventId}`);
  const [entities, claims, links, documents] = await Promise.all([
    pool.query<{ id: string; name: string; type: string; role: string }>(
      `select n.id, n.name, n.type, ee.role from event_entities ee join entities n on n.id = ee.entity_id
       where ee.event_id = $1 order by n.id`,
      [eventId],
    ),
    pool.query<{
      id: string; text: string; asserted_at: Date; kind: 'fact' | 'speculation'; verdict: Claim['verdict'];
      evidence_url: string | null; superseded_by: string | null; disputed_with: string[]; hidden: boolean;
    }>(
      `select c.id, c.text, c.asserted_at, c.kind, c.verdict, c.evidence_url, c.superseded_by, (${hiddenClaim('c')}) as hidden,
              array(select o.id from claims o where o.id = c.conflicts_with or o.conflicts_with = c.id order by o.id) as disputed_with
       from claims c where c.event_id = $1 order by c.asserted_at, c.id`,
      [eventId],
    ),
    pool.query<{ id: string; title: string; type: string; direction: 'out' | 'in'; reason: string }>(
      `select e.id, e.title, l.type, case when l.src = $1 then 'out' else 'in' end as direction, l.reason
       from links l join events e on e.id = case when l.src = $1 then l.dst else l.src end
       where l.src = $1 or l.dst = $1 order by l.id`,
      [eventId],
    ),
    pool.query<{ id: string; title: string | null; source: string | null; url: string | null; published_at: Date }>(
      `select id, title, source, url, ${documentDate('documents')} as published_at from documents
       where event_id = $1 order by id`,
      [eventId],
    ),
  ]);
  const all: Claim[] = claims.rows.map((c) => ({
    claimId: c.id, text: c.text, assertedAt: c.asserted_at, kind: c.kind, disputedWith: c.disputed_with,
    verdict: c.verdict, evidenceUrl: c.evidence_url, supersededBy: c.superseded_by, hidden: c.hidden,
  }));
  const current = (c: Claim): boolean => includeHistory || (c.supersededBy === null && !c.hidden);
  return {
    eventId: e.id,
    title: e.title,
    eventType: e.event_type,
    pattern: e.pattern,
    occurredAt: e.occurred_at,
    storyline: e.storyline_id ? { storylineId: e.storyline_id, title: e.storyline_title! } : null,
    entities: entities.rows.map((r) => ({ entityId: r.id, name: r.name, type: r.type, role: r.role })),
    claims: all.filter((c) => c.kind === 'fact' && current(c)),
    speculation: all.filter((c) => c.kind === 'speculation' && current(c)),
    links: links.rows.map((r) => ({ eventId: r.id, title: r.title, type: r.type, direction: r.direction, reason: r.reason })),
    documents: documents.rows.map((r) => ({
      documentId: r.id, title: r.title, source: r.source, url: r.url, publishedAt: r.published_at,
    })),
  };
}

export async function renderEvent(eventId: string): Promise<string> {
  const event = await getEvent(eventId);
  return [event.title, ...event.claims.map((c) => `- ${c.text}`)].join('\n');
}

export async function getStoryline(storylineId: string): Promise<{
  storylineId: string;
  title: string;
  events: { eventId: string; title: string; occurredAt: string }[];
}> {
  const s = await pool.query<{ title: string }>('select title from storylines where id = $1', [storylineId]);
  if (!s.rows[0]) throw new Error(`no storyline ${storylineId}`);
  const events = await pool.query<{ id: string; title: string; occurred_at: string }>(
    'select id, title, occurred_at from events where storyline_id = $1 order by occurred_at, id',
    [storylineId],
  );
  return {
    storylineId,
    title: s.rows[0].title,
    events: events.rows.map((e) => ({ eventId: e.id, title: e.title, occurredAt: e.occurred_at })),
  };
}

type SimilarEvent = { eventId: string; title: string; occurredAt: string; pattern: string; score: number };

async function similarByVector(v: string, k: number, exclude: string | null): Promise<SimilarEvent[]> {
  const { rows } = await pool.query<{ id: string; title: string; occurred_at: string; pattern: string; score: number }>(
    `select id, title, occurred_at, pattern, 1 - (pattern_embedding <=> $1::vector) as score
     from events where $3::bigint is null or id <> $3
     order by pattern_embedding <=> $1::vector limit $2`,
    [v, k, exclude],
  );
  return rows.map((r) => ({ eventId: r.id, title: r.title, occurredAt: r.occurred_at, pattern: r.pattern, score: Number(r.score) }));
}

export async function similarEvents(eventId: string, k = 5): Promise<SimilarEvent[]> {
  const { rows } = await pool.query<{ v: string }>('select pattern_embedding::text as v from events where id = $1', [eventId]);
  if (!rows[0]) throw new Error(`no event ${eventId}`);
  return similarByVector(rows[0].v, k, eventId);
}

type EventHit = { event_id: string; title: string; occurred_at: string };

// Hybrid: vector rank and full-text rank fused with reciprocal rank fusion.
async function searchEvents(query: string, k: number, dateFrom?: string, dateTo?: string): Promise<EventHit[]> {
  const [v] = await embed([query]);
  const { rows } = await pool.query<{ id: string; title: string; occurred_at: string }>(
    `with q as (
       select $1::vector as v,
              to_tsquery('english', nullif(array_to_string(array(
                select '''' || replace(l, '''', '''''') || ''''
                from unnest(tsvector_to_array(to_tsvector('english', $2))) l), ' | '), '')) as tsq
     ),
     scope as (
       select e.* from events e
       where ($3::date is null or e.occurred_at >= $3) and ($4::date is null or e.occurred_at <= $4)
     ),
     vec as (
       select e.id, row_number() over (order by e.content_embedding <=> q.v) as r
       from scope e, q order by e.content_embedding <=> q.v limit $5
     ),
     fts as (
       select e.id, row_number() over (order by
         ts_rank(to_tsvector('english', e.title), q.tsq)
         + coalesce((select sum(ts_rank(c.tsv, q.tsq)) from claims c
                     where c.event_id = e.id and c.tsv @@ q.tsq and ${liveClaim('c')}), 0) desc) as r
       from scope e, q
       where to_tsvector('english', e.title) @@ q.tsq
          or exists (select 1 from claims c where c.event_id = e.id and c.tsv @@ q.tsq and ${liveClaim('c')})
       limit $5
     )
     select e.id, e.title, e.occurred_at
     from scope e left join vec on vec.id = e.id left join fts on fts.id = e.id
     where vec.id is not null or fts.id is not null
     order by coalesce(1.0 / (60 + vec.r), 0) + coalesce(1.0 / (60 + fts.r), 0) desc, e.id
     limit $6`,
    [vec(v!), query, dateFrom ?? null, dateTo ?? null, k * 2, k],
  );
  return rows.map((r) => ({ event_id: pid('E', r.id), title: r.title, occurred_at: r.occurred_at }));
}

const toolClaim = (c: Claim) => ({
  claim_id: pid('C', c.claimId),
  text: c.text,
  asserted_at: c.assertedAt.toISOString().slice(0, 10),
  ...(c.disputedWith.length > 0 ? { disputed_with: c.disputedWith.map((id) => pid('C', id)) } : {}),
  ...(c.verdict ? { verdict: c.verdict } : {}),
});

function queryTools(seen: Set<string>): Tool[] {
  return [
    {
      name: 'search_events',
      description: 'Find events on a topic. Returns titles only.',
      parameters: z.strictObject({
        query: z.string(),
        k: z.number().int().min(1).max(20).default(8),
        date_from: z.string().optional(),
        date_to: z.string().optional(),
      }),
      run: (a: { query: string; k: number; date_from?: string; date_to?: string }) =>
        searchEvents(a.query, a.k, a.date_from, a.date_to),
    },
    {
      name: 'get_event',
      description: "An event's entities, live claims and speculation, with its storyline id. History adds superseded and hidden claims.",
      parameters: z.strictObject({ event_id: z.string(), include_history: z.boolean().default(false) }),
      run: async (a: { event_id: string; include_history: boolean }) => {
        const e = await getEvent(rawId(a.event_id), a.include_history);
        for (const c of [...e.claims, ...e.speculation]) seen.add(pid('C', c.claimId));
        return {
          title: e.title,
          occurred_at: e.occurredAt,
          ...(e.storyline ? { storyline_id: pid('S', e.storyline.storylineId) } : {}),
          entities: e.entities.map((n) => ({ name: n.name, role: n.role })),
          claims: e.claims.map(toolClaim),
          speculation: e.speculation.map(toolClaim),
        };
      },
    },
    {
      name: 'get_storyline',
      description: "A storyline's title and its events, oldest first.",
      parameters: z.strictObject({ storyline_id: z.string() }),
      run: async (a: { storyline_id: string }) => {
        const s = await getStoryline(rawId(a.storyline_id));
        return { title: s.title, events: s.events.map((e) => ({ event_id: pid('E', e.eventId), title: e.title, occurred_at: e.occurredAt })) };
      },
    },
    {
      name: 'get_neighbors',
      description: 'Events linked to this one, with link type and direction.',
      parameters: z.strictObject({ event_id: z.string(), types: z.array(z.enum(LINK_TYPES)).optional() }),
      run: async (a: { event_id: string; types?: string[] }) => {
        const e = await getEvent(rawId(a.event_id));
        return e.links
          .filter((l) => !a.types || a.types.includes(l.type))
          .map((l) => ({ event_id: pid('E', l.eventId), title: l.title, type: l.type, direction: l.direction, reason: l.reason }));
      },
    },
    {
      name: 'find_similar',
      description: 'Events with a similar pattern, by a pattern description or an event id.',
      parameters: z
        .strictObject({ pattern: z.string().optional(), event_id: z.string().optional(), k: z.number().int().min(1).max(20).default(5) })
        .refine((a) => Boolean(a.pattern) !== Boolean(a.event_id), 'give pattern or event_id'),
      run: async (a: { pattern?: string; event_id?: string; k: number }) => {
        const hits = a.event_id
          ? await similarEvents(rawId(a.event_id), a.k)
          : await similarByVector(vec((await embed([a.pattern!]))[0]!), a.k, null);
        return hits.map((h) => ({ event_id: pid('E', h.eventId), title: h.title, occurred_at: h.occurredAt, pattern: h.pattern }));
      },
    },
  ];
}

export type Citation = { claimId: string; text: string; source: string | null; url: string | null; publishedAt: Date };

export async function ask(question: string): Promise<{ answer: string; citations: Citation[] }> {
  const seen = new Set<string>();
  const schema = z.strictObject({
    answer: maxWords(120),
    claim_ids: z.array(z.string().refine((id) => seen.has(id), 'claim id was not retrieved')),
  });
  const reply = await runTools(await render('query'), question, queryTools(seen), schema, QUERY_MAX_TOOL_CALLS);
  const ids = [...new Set(reply.claim_ids)].map(unpid);
  const { rows } = await pool.query<{ id: string; text: string; source: string | null; url: string | null; published_at: Date }>(
    `select c.id, c.text, d.source, d.url, ${documentDate('d')} as published_at
     from claims c join documents d on d.id = c.document_id where c.id = any($1::bigint[]) order by c.id`,
    [ids],
  );
  return {
    answer: reply.answer,
    citations: rows.map((r) => ({ claimId: r.id, text: r.text, source: r.source, url: r.url, publishedAt: r.published_at })),
  };
}

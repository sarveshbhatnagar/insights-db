import { z } from 'zod';
import { QUERY_MAX_TOOL_CALLS } from './config.ts';
import { type Connection, documentDate, hiddenClaim, liveClaim, observedAt, vec } from './db.ts';
import { type AsOf, type Claim, loadClaims, similar } from './events.ts';
import { LINK_TYPES } from './link.ts';
import { embed, runTools, type Tool } from './llm.ts';
import { maxWords, pid, render, unpid } from './prompts.ts';

export type { Claim } from './events.ts';

export type EventDetail = {
  eventId: string;
  title: string;
  eventType: string;
  pattern: string;
  occurredAt: string;
  observedAt: Date;
  storyline: { storylineId: string; title: string } | null;
  entities: { entityId: string; name: string; type: string; role: string }[];
  claims: Claim[];
  speculation: Claim[];
  links: { eventId: string; title: string; type: string; direction: 'out' | 'in'; reason: string }[];
  documents: { documentId: string; title: string | null; source: string | null; url: string | null; publishedAt: Date }[];
};

// Tool arguments may carry the prompt prefix (E17) or not (17).
const rawId = (s: string): string => (/^[A-Z]\d+$/.test(s) ? unpid(s) : s);

export type GetEventOptions = {
  // Adds superseded claims, and hidden claims with their verdict and evidence URL.
  includeHistory?: boolean | undefined;
  // The event as it stood then: claims asserted and documents dated by `asOf`.
  // An event not yet observed at `asOf` does not exist.
  asOf?: AsOf | undefined;
};

export async function getEvent(conn: Connection, eventId: string, opts: GetEventOptions = {}): Promise<EventDetail> {
  const asOf = opts.asOf ?? null;
  const event = await conn.pool.query<{
    id: string; title: string; event_type: string; pattern: string; occurred_at: string; observed_at: Date;
    storyline_id: string | null; storyline_title: string | null;
  }>(
    `select e.id, e.title, e.event_type, e.pattern, e.occurred_at, ${observedAt('e')} as observed_at,
            e.storyline_id, s.title as storyline_title
     from events e left join storylines s on s.id = e.storyline_id
     where e.id = $1 and ($2::timestamptz is null or ${observedAt('e')} <= $2)`,
    [eventId, asOf],
  );
  const e = event.rows[0];
  if (!e) throw new Error(`no event ${eventId}`);
  const [entities, claims, links, documents] = await Promise.all([
    conn.pool.query<{ id: string; name: string; type: string; role: string }>(
      `select n.id, n.name, n.type, ee.role from event_entities ee join entities n on n.id = ee.entity_id
       where ee.event_id = $1 order by n.id`,
      [eventId],
    ),
    loadClaims(conn, [eventId], opts.asOf),
    conn.pool.query<{ id: string; title: string; type: string; direction: 'out' | 'in'; reason: string }>(
      `select e.id, e.title, l.type, case when l.src = $1 then 'out' else 'in' end as direction, l.reason
       from links l join events e on e.id = case when l.src = $1 then l.dst else l.src end
       where l.src = $1 or l.dst = $1 order by l.id`,
      [eventId],
    ),
    conn.pool.query<{ id: string; title: string | null; source: string | null; url: string | null; published_at: Date }>(
      `select id, title, source, url, ${documentDate('documents')} as published_at from documents
       where event_id = $1 and ($2::timestamptz is null or ${documentDate('documents')} <= $2) order by id`,
      [eventId, asOf],
    ),
  ]);
  const all = claims.get(eventId) ?? [];
  const current = (c: Claim): boolean => opts.includeHistory === true || (c.supersededBy === null && !c.hidden);
  return {
    eventId: e.id,
    title: e.title,
    eventType: e.event_type,
    pattern: e.pattern,
    occurredAt: e.occurred_at,
    observedAt: e.observed_at,
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

export async function renderEvent(conn: Connection, eventId: string): Promise<string> {
  const event = await getEvent(conn, eventId);
  return [event.title, ...event.claims.map((c) => `- ${c.text}`)].join('\n');
}

export async function getStoryline(conn: Connection, storylineId: string): Promise<{
  storylineId: string;
  title: string;
  events: { eventId: string; title: string; occurredAt: string }[];
}> {
  const s = await conn.pool.query<{ title: string }>('select title from storylines where id = $1', [storylineId]);
  if (!s.rows[0]) throw new Error(`no storyline ${storylineId}`);
  const events = await conn.pool.query<{ id: string; title: string; occurred_at: string }>(
    'select id, title, occurred_at from events where storyline_id = $1 order by occurred_at, id',
    [storylineId],
  );
  return {
    storylineId,
    title: s.rows[0].title,
    events: events.rows.map((e) => ({ eventId: e.id, title: e.title, occurredAt: e.occurred_at })),
  };
}

export type SimilarEvent = { eventId: string; title: string; occurredAt: string; pattern: string; score: number };

// Events with a pattern like this one's, nearest first, by the immutable pattern embedding.
export async function similarEvents(conn: Connection, eventId: string, k = 5): Promise<SimilarEvent[]> {
  const hits = await similar(conn, { eventId, k });
  return hits.map((h) => ({ eventId: h.id, title: h.title, occurredAt: h.occurredAt, pattern: h.pattern, score: h.score }));
}

// The query's lexemes ORed together, so partial matches still rank.
const TSQUERY = `to_tsquery('english', nullif(array_to_string(array(
  select '''' || replace(l, '''', '''''') || ''''
  from unnest(tsvector_to_array(to_tsvector('english', $2))) l), ' | '), ''))`;

export type EventHit = { eventId: string; title: string; occurredAt: string };

// Hybrid: vector rank and full-text rank fused with reciprocal rank fusion.
export async function searchEvents(
  conn: Connection,
  query: string,
  opts: { k?: number | undefined; dateFrom?: string | undefined; dateTo?: string | undefined } = {},
): Promise<EventHit[]> {
  const k = opts.k ?? 8;
  const [v] = await embed([query]);
  const { rows } = await conn.pool.query<{ id: string; title: string; occurred_at: string }>(
    `with q as (select $1::vector as v, ${TSQUERY} as tsq),
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
    [vec(v!), query, opts.dateFrom ?? null, opts.dateTo ?? null, k * 2, k],
  );
  return rows.map((r) => ({ eventId: r.id, title: r.title, occurredAt: r.occurred_at }));
}

export type ClaimHit = {
  claimId: string;
  eventId: string;
  text: string;
  kind: 'fact' | 'speculation';
  assertedAt: Date;
  verdict: 'refuted' | 'unsupported' | null;
  against: string[];
  disputedWith: string[];
  evidenceUrl: string | null;
  hidden: boolean;
};

// Single claims, hidden ones included: the way to find speculation and claims
// that failed verification. Same hybrid ranking as searchEvents; without a
// query, newest first.
export async function listClaims(
  conn: Connection,
  opts: { query?: string | undefined; speculation?: boolean | undefined; verdict?: 'refuted' | 'unsupported' | undefined; k?: number | undefined } = {},
): Promise<ClaimHit[]> {
  const k = opts.k ?? 20;
  const kind = opts.speculation === undefined ? null : opts.speculation ? 'speculation' : 'fact';
  const v = opts.query ? vec((await embed([opts.query]))[0]!) : null;
  const { rows } = await conn.pool.query<{
    id: string; event_id: string; text: string; kind: 'fact' | 'speculation'; asserted_at: Date;
    verdict: ClaimHit['verdict']; against: string[]; disputed_with: string[]; evidence_url: string | null; hidden: boolean;
  }>(
    `with q as (select $1::vector as v, ${TSQUERY} as tsq),
     scope as (
       select c.* from claims c
       where ($3::text is null or c.kind = $3) and ($4::text is null or c.verdict = $4)
     ),
     vec as (
       select c.id, row_number() over (order by c.embedding <=> q.v) as r
       from scope c, q where q.v is not null order by c.embedding <=> q.v limit $5
     ),
     fts as (
       select c.id, row_number() over (order by ts_rank(c.tsv, q.tsq) desc) as r
       from scope c, q where c.tsv @@ q.tsq limit $5
     )
     select c.id, c.event_id, c.text, c.kind, c.asserted_at, c.verdict, c.against, c.evidence_url,
            (${hiddenClaim('c')}) as hidden,
            array(select o.id from claims o where o.id = c.conflicts_with or o.conflicts_with = c.id order by o.id) as disputed_with
     from scope c left join vec on vec.id = c.id left join fts on fts.id = c.id
     where $2::text is null or vec.id is not null or fts.id is not null
     order by coalesce(1.0 / (60 + vec.r), 0) + coalesce(1.0 / (60 + fts.r), 0) desc, c.asserted_at desc, c.id desc
     limit $6`,
    [v, opts.query ?? null, kind, opts.verdict ?? null, k * 2, k],
  );
  return rows.map((r) => ({
    claimId: r.id, eventId: r.event_id, text: r.text, kind: r.kind, assertedAt: r.asserted_at, verdict: r.verdict,
    against: r.against, disputedWith: r.disputed_with, evidenceUrl: r.evidence_url, hidden: r.hidden,
  }));
}

export type EntityHit = { entityId: string; name: string; type: string; aliases: string[]; events: number };

// Entities by name or alias, nearest first; the way to spot duplicates for mergeEntities.
export async function listEntities(conn: Connection, opts: { query?: string | undefined; type?: string | undefined; k?: number | undefined } = {}): Promise<EntityHit[]> {
  const v = opts.query ? vec((await embed([opts.query]))[0]!) : null;
  const { rows } = await conn.pool.query<{ id: string; name: string; type: string; aliases: string[]; events: string }>(
    `select n.id, n.name, n.type, n.aliases, (select count(*) from event_entities ee where ee.entity_id = n.id) as events
     from entities n
     where ($2::text is null or n.type = $2)
     order by ($1::text is not null and (n.name ilike '%' || $1 || '%'
                or exists (select 1 from unnest(n.aliases) a where a ilike '%' || $1 || '%'))) desc,
              case when $3::vector is null then 0 else n.embedding <=> $3::vector end,
              n.id
     limit $4`,
    [opts.query ?? null, opts.type ?? null, v, opts.k ?? 20],
  );
  return rows.map((r) => ({ entityId: r.id, name: r.name, type: r.type, aliases: r.aliases, events: Number(r.events) }));
}

const toolClaim = (c: Claim) => ({
  claim_id: pid('C', c.claimId),
  text: c.text,
  asserted_at: c.assertedAt.toISOString().slice(0, 10),
  ...(c.disputedWith.length > 0 ? { disputed_with: c.disputedWith.map((id) => pid('C', id)) } : {}),
  ...(c.verdict ? { verdict: c.verdict } : {}),
});

function queryTools(conn: Connection, seen: Set<string>): Tool[] {
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
      run: async (a: { query: string; k: number; date_from?: string; date_to?: string }) =>
        (await searchEvents(conn, a.query, { k: a.k, dateFrom: a.date_from, dateTo: a.date_to })).map((e) => ({
          event_id: pid('E', e.eventId), title: e.title, occurred_at: e.occurredAt,
        })),
    },
    {
      name: 'get_event',
      description: "An event's entities, live claims and speculation, with its storyline id. History adds superseded and hidden claims.",
      parameters: z.strictObject({ event_id: z.string(), include_history: z.boolean().default(false) }),
      run: async (a: { event_id: string; include_history: boolean }) => {
        const e = await getEvent(conn, rawId(a.event_id), { includeHistory: a.include_history });
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
        const s = await getStoryline(conn, rawId(a.storyline_id));
        return { title: s.title, events: s.events.map((e) => ({ event_id: pid('E', e.eventId), title: e.title, occurred_at: e.occurredAt })) };
      },
    },
    {
      name: 'get_neighbors',
      description: 'Events linked to this one, with link type and direction.',
      parameters: z.strictObject({ event_id: z.string(), types: z.array(z.enum(LINK_TYPES)).optional() }),
      run: async (a: { event_id: string; types?: string[] }) => {
        const e = await getEvent(conn, rawId(a.event_id));
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
          ? await similar(conn, { eventId: rawId(a.event_id), k: a.k })
          : await similar(conn, { embedding: (await embed([a.pattern!]))[0]!, k: a.k });
        return hits.map((h) => ({ event_id: pid('E', h.id), title: h.title, occurred_at: h.occurredAt, pattern: h.pattern }));
      },
    },
    {
      name: 'search_claims',
      description: 'Find single claims, including speculation and claims that failed verification.',
      parameters: z.strictObject({
        query: z.string(),
        speculation: z.boolean().optional(),
        verdict: z.enum(['refuted', 'unsupported']).optional(),
        k: z.number().int().min(1).max(20).default(10),
      }),
      run: async (a: { query: string; speculation?: boolean; verdict?: 'refuted' | 'unsupported'; k: number }) => {
        const hits = await listClaims(conn, { query: a.query, k: a.k, speculation: a.speculation, verdict: a.verdict });
        for (const h of hits) seen.add(pid('C', h.claimId));
        return hits.map((h) => ({
          claim_id: pid('C', h.claimId), event_id: pid('E', h.eventId), text: h.text, kind: h.kind,
          ...(h.verdict ? { verdict: h.verdict } : {}),
          ...(h.against.length ? { against: h.against.map((id) => pid('C', id)) } : {}),
          ...(h.evidenceUrl ? { evidence_url: h.evidenceUrl } : {}),
        }));
      },
    },
  ];
}

export type Citation = { claimId: string; text: string; source: string | null; url: string | null; publishedAt: Date };

export async function ask(conn: Connection, question: string): Promise<{ answer: string; citations: Citation[] }> {
  const seen = new Set<string>();
  const schema = z.strictObject({
    answer: maxWords(120),
    claim_ids: z.array(z.string().refine((id) => seen.has(id), 'claim id was not retrieved')),
  });
  const reply = await runTools(await render(conn, 'query'), question, queryTools(conn, seen), schema, QUERY_MAX_TOOL_CALLS);
  const ids = [...new Set(reply.claim_ids)].map(unpid);
  const { rows } = await conn.pool.query<{ id: string; text: string; source: string | null; url: string | null; published_at: Date }>(
    `select c.id, c.text, d.source, d.url, ${documentDate('d')} as published_at
     from claims c join documents d on d.id = c.document_id where c.id = any($1::bigint[]) order by c.id`,
    [ids],
  );
  return {
    answer: reply.answer,
    citations: rows.map((r) => ({ claimId: r.id, text: r.text, source: r.source, url: r.url, publishedAt: r.published_at })),
  };
}

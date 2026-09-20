import { type Connection, hiddenClaim, observedAt, supersededAsOf, vec } from './db.ts';
import { isoDate } from './prompts.ts';

// The read side of the store: events as records, no LLM calls. Written for a
// second system (hindsight-db) that keeps its own context keyed by event id and
// must never see anything later than a chosen instant.
//
// Two clocks: `occurredAt` is the event's date (a calendar day, YYYY-MM-DD;
// treat it as 00:00 UTC), `observedAt` is when the store first learned of it,
// the earliest of its documents' dates. `asOf` cuts on the second clock and
// leaves each event as it stood then: claims asserted by `asOf`, with a
// supersession counted only once the superseding claim was asserted.

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

export type EventEntity = { id: string; name: string; type: string; role: string };

export type EventRecord = {
  id: string;
  occurredAt: string;
  observedAt: Date;
  eventType: string;
  title: string;
  pattern: string;
  storylineId: string | null;
  entities: EventEntity[];
  // Current facts and speculation, oldest first; superseded and hidden claims stay out.
  claims: Claim[];
};

export type AsOf = Date | string;

export type EventFilters = {
  eventType?: string | string[] | undefined;
  // Events touching any of these entities.
  entityIds?: string[] | undefined;
  // Bounds on occurredAt, inclusive, as YYYY-MM-DD or a Date (its UTC day).
  from?: Date | string | undefined;
  to?: Date | string | undefined;
  asOf?: AsOf | undefined;
  excludeIds?: string[] | undefined;
};

export type ListQuery = EventFilters & {
  limit?: number | undefined;
  cursor?: string | undefined;
  order?: 'asc' | 'desc' | undefined;
};

export type Page<T> = { items: T[]; nextCursor?: string };

export type SimilarQuery = ({ eventId: string; embedding?: undefined } | { embedding: number[]; eventId?: undefined }) & {
  k?: number | undefined;
  minScore?: number | undefined;
  filters?: EventFilters | undefined;
};

export type Vector = 'pattern' | 'content';

export type TypeStats = { eventType: string; count: number; from: string; to: string };
export type EntityStats = { id: string; name: string; type: string; count: number; from: string; to: string };

type EventRow = {
  id: string; title: string; event_type: string; pattern: string; occurred_at: string;
  storyline_id: string | null; observed_at: Date;
};
const EVENT = (e: string): string =>
  `${e}.id, ${e}.title, ${e}.event_type, ${e}.pattern, ${e}.occurred_at, ${e}.storyline_id, ${observedAt(e)} as observed_at`;

// The filters as one predicate over alias e, bound to $1..$6 in this order.
const FILTERS = `($1::text[] is null or e.event_type = any($1))
  and ($2::bigint[] is null or exists (select 1 from event_entities ee where ee.event_id = e.id and ee.entity_id = any($2)))
  and ($3::date is null or e.occurred_at >= $3)
  and ($4::date is null or e.occurred_at <= $4)
  and ($5::timestamptz is null or ${observedAt('e')} <= $5)
  and ($6::bigint[] is null or e.id <> all($6))`;

const filterParams = (f: EventFilters): unknown[] => [
  f.eventType === undefined ? null : [f.eventType].flat(),
  f.entityIds ?? null,
  f.from === undefined ? null : isoDate(f.from),
  f.to === undefined ? null : isoDate(f.to),
  f.asOf ?? null,
  f.excludeIds ?? null,
];

const LIMIT = 50;

const encodeCursor = (occurredAt: string, id: string): string => Buffer.from(`${occurredAt} ${id}`).toString('base64url');
function decodeCursor(cursor: string): [occurredAt: string, id: string] {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d+)$/.exec(Buffer.from(cursor, 'base64url').toString());
  if (!m) throw new Error('invalid cursor');
  return [m[1]!, m[2]!];
}

// Entities and claims for a set of event rows, in two queries, keeping the rows' order.
async function hydrate(conn: Connection, rows: EventRow[], asOf: AsOf | undefined): Promise<EventRecord[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [entities, claims] = await Promise.all([
    conn.pool.query<EventEntity & { event_id: string }>(
      `select ee.event_id, n.id, n.name, n.type, ee.role from event_entities ee join entities n on n.id = ee.entity_id
       where ee.event_id = any($1::bigint[]) order by n.id`,
      [ids],
    ),
    loadClaims(conn, ids, asOf),
  ]);
  return rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    observedAt: r.observed_at,
    eventType: r.event_type,
    title: r.title,
    pattern: r.pattern,
    storylineId: r.storyline_id,
    entities: entities.rows.filter((n) => n.event_id === r.id).map(({ id, name, type, role }) => ({ id, name, type, role })),
    claims: (claims.get(r.id) ?? []).filter((c) => c.supersededBy === null && !c.hidden),
  }));
}

// Every claim of each event as it stood at `asOf`, oldest first; the caller
// decides whether superseded and hidden ones are wanted.
export async function loadClaims(conn: Connection, eventIds: string[], asOf: AsOf | undefined): Promise<Map<string, Claim[]>> {
  const { rows } = await conn.pool.query<{
    id: string; event_id: string; text: string; asserted_at: Date; kind: 'fact' | 'speculation'; verdict: Claim['verdict'];
    evidence_url: string | null; superseded_by: string | null; disputed_with: string[]; hidden: boolean;
  }>(
    `select c.id, c.event_id, c.text, c.asserted_at, c.kind, c.verdict, c.evidence_url, (${hiddenClaim('c')}) as hidden,
            ${supersededAsOf('c', '$2')} as superseded_by,
            array(select o.id from claims o where (o.id = c.conflicts_with or o.conflicts_with = c.id)
                  and ($2::timestamptz is null or o.asserted_at <= $2) order by o.id) as disputed_with
     from claims c where c.event_id = any($1::bigint[]) and ($2::timestamptz is null or c.asserted_at <= $2)
     order by c.asserted_at, c.id`,
    [eventIds, asOf ?? null],
  );
  const byEvent = new Map<string, Claim[]>();
  for (const c of rows) {
    const list = byEvent.get(c.event_id) ?? [];
    list.push({
      claimId: c.id, text: c.text, assertedAt: c.asserted_at, kind: c.kind, disputedWith: c.disputed_with,
      verdict: c.verdict, evidenceUrl: c.evidence_url, supersededBy: c.superseded_by, hidden: c.hidden,
    });
    byEvent.set(c.event_id, list);
  }
  return byEvent;
}

// Events by id, in the order asked; ids that do not exist, or were not yet
// observed at `asOf`, are left out.
export async function getMany(conn: Connection, ids: string[], opts: { asOf?: AsOf | undefined } = {}): Promise<EventRecord[]> {
  if (ids.length === 0) return [];
  const { rows } = await conn.pool.query<EventRow>(
    `select ${EVENT('e')} from events e
     where e.id = any($1::bigint[]) and ($2::timestamptz is null or ${observedAt('e')} <= $2)`,
    [ids, opts.asOf ?? null],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return hydrate(conn, ids.map((id) => byId.get(id)).filter((r) => r !== undefined), opts.asOf);
}

// A page of events in (occurredAt, id) order; pass `nextCursor` back for the next one.
export async function list(conn: Connection, query: ListQuery = {}): Promise<Page<EventRecord>> {
  const limit = query.limit ?? LIMIT;
  const desc = query.order === 'desc';
  const [after, afterId] = query.cursor ? decodeCursor(query.cursor) : [null, null];
  const { rows } = await conn.pool.query<EventRow>(
    `select ${EVENT('e')} from events e
     where ${FILTERS} and ($7::date is null or (e.occurred_at, e.id) ${desc ? '<' : '>'} ($7, $8::bigint))
     order by e.occurred_at ${desc ? 'desc' : 'asc'}, e.id ${desc ? 'desc' : 'asc'} limit $9`,
    [...filterParams(query), after, afterId, limit + 1],
  );
  const page = rows.slice(0, limit);
  const items = await hydrate(conn, page, query.asOf);
  const last = page.at(-1);
  return rows.length > limit && last ? { items, nextCursor: encodeCursor(last.occurred_at, last.id) } : { items };
}

// Nearest events by cosine over one of the two embeddings, best first. The
// pattern embedding is written once and never changes; the content embedding
// is rewritten as claims merge, so it reflects everything known today.
export async function similar(conn: Connection, query: SimilarQuery, vector: Vector = 'pattern'): Promise<(EventRecord & { score: number })[]> {
  const column = `${vector}_embedding`;
  let v: string;
  const filters = { ...query.filters };
  if (query.eventId !== undefined) {
    const { rows } = await conn.pool.query<{ v: string }>(`select ${column}::text as v from events where id = $1`, [query.eventId]);
    if (!rows[0]) throw new Error(`no event ${query.eventId}`);
    v = rows[0].v;
    filters.excludeIds = [...(filters.excludeIds ?? []), query.eventId];
  } else v = vec(query.embedding);
  const { rows } = await conn.pool.query<EventRow & { score: number }>(
    `select ${EVENT('e')}, 1 - (e.${column} <=> $7::vector) as score from events e
     where ${FILTERS} and ($9::float is null or 1 - (e.${column} <=> $7::vector) >= $9)
     order by e.${column} <=> $7::vector, e.id limit $8`,
    [...filterParams(filters), v, query.k ?? 5, query.minScore ?? null],
  );
  const records = await hydrate(conn, rows, filters.asOf);
  return records.map((r, i) => ({ ...r, score: Number(rows[i]!.score) }));
}

// The event types in use, most frequent first, with the span of their occurredAt.
export async function types(conn: Connection): Promise<TypeStats[]> {
  const { rows } = await conn.pool.query<{ event_type: string; count: string; from: string; to: string }>(
    `select event_type, count(*) as count, min(occurred_at) as "from", max(occurred_at) as "to"
     from events group by event_type order by count(*) desc, event_type`,
  );
  return rows.map((r) => ({ eventType: r.event_type, count: Number(r.count), from: r.from, to: r.to }));
}

// The entities in use, most frequent first, with the span of their events'
// occurredAt; optionally counting only events of some types or dates.
export async function entities(
  conn: Connection,
  query: { eventType?: string | string[] | undefined; from?: Date | string | undefined; to?: Date | string | undefined; limit?: number | undefined } = {},
): Promise<EntityStats[]> {
  const { rows } = await conn.pool.query<{ id: string; name: string; type: string; count: string; from: string; to: string }>(
    `select n.id, n.name, n.type, count(*) as count, min(e.occurred_at) as "from", max(e.occurred_at) as "to"
     from entities n join event_entities ee on ee.entity_id = n.id join events e on e.id = ee.event_id
     where ($1::text[] is null or e.event_type = any($1))
       and ($2::date is null or e.occurred_at >= $2) and ($3::date is null or e.occurred_at <= $3)
     group by n.id order by count(*) desc, n.name, n.id limit $4`,
    [query.eventType === undefined ? null : [query.eventType].flat(),
      query.from === undefined ? null : isoDate(query.from), query.to === undefined ? null : isoDate(query.to), query.limit ?? 1000],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, type: r.type, count: Number(r.count), from: r.from, to: r.to }));
}

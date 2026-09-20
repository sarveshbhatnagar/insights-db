import { CLAIM_DUP_COSINE, NEAR_DUP_WINDOW_DAYS, SIMHASH_MAX_HAMMING } from './config.ts';
import { type Db, documentDate, hiddenClaim, liveClaim, pool, vec, withTransaction } from './db.ts';
import { consolidate, findCandidates, type NewClaim } from './consolidate.ts';
import { fromSigned64, hamming, normalize, sha256, simhash, toSigned64 } from './dedup.ts';
import { resolveEntities } from './entities.ts';
import { type DocumentRow, extract } from './extract.ts';
import { linkEvent } from './link.ts';
import { embed } from './llm.ts';
import { pid, unpid } from './prompts.ts';

export type DocumentIn = {
  body: string;
  title?: string;
  publishedAt?: string | Date;
  source?: string;
  url?: string;
};

export type IngestResult = {
  documentId: string;
  eventId: string | null;
  outcome: 'duplicate' | 'merged' | 'new' | 'failed';
  newClaims: number;
  newLinks: number;
};

// A string without an offset is UTC; anything unparseable rejects the document.
export function parsePublishedAt(value: string | Date | undefined): Date | null {
  if (value === undefined) return null;
  let date: Date;
  if (value instanceof Date) date = value;
  else {
    const s = value.trim();
    const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
    date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : hasOffset ? s : `${s}Z`);
  }
  if (Number.isNaN(date.getTime())) throw new Error(`unparseable publishedAt: ${String(value)}`);
  return date;
}

export const contentText = (title: string, claims: string[]): string => [title, ...claims].join('\n');

export async function recomputeContentEmbedding(db: Db, eventId: string): Promise<void> {
  const { rows } = await db.query<{ title: string; claims: string[] }>(
    `select e.title, array(select c.text from claims c where c.event_id = e.id and ${liveClaim('c')}
                          order by c.asserted_at, c.id) as claims
     from events e where e.id = $1`,
    [eventId],
  );
  const [embedding] = await embed([contentText(rows[0]!.title, rows[0]!.claims)]);
  await db.query('update events set content_embedding = $2::vector where id = $1', [eventId, vec(embedding!)]);
}

export async function ingest(doc: DocumentIn): Promise<IngestResult> {
  if (typeof doc.body !== 'string' || !doc.body.trim()) throw new Error('body is required and must be non-empty');
  const publishedAt = parsePublishedAt(doc.publishedAt);

  // Step 1: dedup gate. Failed documents are ignored so they can be re-ingested.
  const hash = sha256(normalize(`${doc.title ?? ''} ${doc.body}`));
  const sim = simhash(normalize(doc.body));
  const stored = await pool.query<{ id: string; event_id: string | null; simhash: string; exact: boolean }>(
    `select id, event_id, simhash, content_hash = $1 as exact from documents
     where duplicate_of is null and error is null
       and (content_hash = $1
            or ${documentDate('documents')} between $2::timestamptz - $3 * interval '1 day'
                                                and $2::timestamptz + $3 * interval '1 day')
     order by content_hash = $1 desc, id`,
    [hash, publishedAt ?? new Date(), NEAR_DUP_WINDOW_DAYS],
  );
  const original = stored.rows.find((r) => r.exact || hamming(fromSigned64(r.simhash), sim) <= SIMHASH_MAX_HAMMING);
  const inserted = await pool.query<{ id: string; document_date: Date }>(
    `insert into documents (url, source, title, body, published_at, content_hash, simhash, duplicate_of, event_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id, ${documentDate('documents')} as document_date`,
    [doc.url ?? null, doc.source ?? null, doc.title ?? null, doc.body, publishedAt, hash, toSigned64(sim),
      original?.id ?? null, original?.event_id ?? null],
  );
  const documentId = inserted.rows[0]!.id;
  if (original) return { documentId, eventId: original.event_id, outcome: 'duplicate', newClaims: 0, newLinks: 0 };

  const row: DocumentRow = {
    id: documentId,
    title: doc.title ?? null,
    body: doc.body,
    source: doc.source ?? null,
    documentDate: inserted.rows[0]!.document_date,
  };
  return runPipeline(row);
}

// Steps 2 to 7 in one transaction; on any error the document is marked failed.
export async function runPipeline(row: DocumentRow, excludeEventId?: string): Promise<IngestResult> {
  try {
    const result = await withTransaction((client) => processDocument(client, row, excludeEventId));
    return { documentId: row.id, ...result };
  } catch (err) {
    await pool.query('update documents set error = $2 where id = $1', [row.id, (err as Error).message]);
    return { documentId: row.id, eventId: null, outcome: 'failed', newClaims: 0, newLinks: 0 };
  }
}

async function processDocument(
  db: Db,
  row: DocumentRow,
  excludeEventId: string | undefined,
): Promise<Omit<IngestResult, 'documentId'>> {
  const extraction = await extract(row);
  const entities = await resolveEntities(db, extraction.entities, extraction.title);
  const newClaims: NewClaim[] = [
    ...extraction.claims.map((text) => ({ text, kind: 'fact' as const })),
    ...extraction.speculation.map((text) => ({ text, kind: 'speculation' as const })),
  ].map((c, i) => ({ ...c, n: pid('N', i + 1) }));

  const [contentEmbedding] = await embed([contentText(extraction.title, extraction.claims)]);
  const candidates = await findCandidates(db, {
    documentDate: row.documentDate,
    entityIds: entities.map((e) => e.entityId),
    embedding: contentEmbedding!,
    exclude: excludeEventId,
  });
  const reply =
    candidates.length > 0
      ? await consolidate(extraction, extraction.entities.map((e) => e.name), row.documentDate, newClaims, candidates)
      : { event_id: null, claims: [] };
  const claimEmbeddings = await embed(newClaims.map((c) => c.text));

  const insertClaim = async (
    eventId: string,
    claim: NewClaim,
    embedding: number[],
    conflictsWith: string | null,
  ): Promise<string> => {
    const res = await db.query<{ id: string }>(
      `insert into claims (event_id, document_id, text, asserted_at, conflicts_with, kind, embedding)
       values ($1, $2, $3, $4, $5, $6, $7::vector) returning id`,
      [eventId, row.id, claim.text, row.documentDate, conflictsWith, claim.kind, vec(embedding)],
    );
    return res.rows[0]!.id;
  };
  const finish = async (eventId: string): Promise<void> => {
    for (const e of entities) {
      await db.query(
        'insert into event_entities (event_id, entity_id, role) values ($1, $2, $3) on conflict do nothing',
        [eventId, e.entityId, e.role],
      );
    }
    await db.query('update documents set event_id = $2 where id = $1', [row.id, eventId]);
  };

  if (reply.event_id === null) {
    const [patternEmbedding] = await embed([extraction.pattern]);
    const event = await db.query<{ id: string }>(
      `insert into events (title, event_type, pattern, occurred_at, content_embedding, pattern_embedding)
       values ($1, $2, $3, $4, $5::vector, $6::vector) returning id`,
      [extraction.title, extraction.event_type, extraction.pattern, extraction.occurred_at,
        vec(contentEmbedding!), vec(patternEmbedding!)],
    );
    const eventId = event.rows[0]!.id;
    for (const [i, claim] of newClaims.entries()) await insertClaim(eventId, claim, claimEmbeddings[i]!, null);
    await finish(eventId);
    const newLinks = await linkEvent(db, eventId, candidates.map((c) => c.id));
    return { eventId, outcome: 'new', newClaims: newClaims.length, newLinks };
  }

  const eventId = unpid(reply.event_id);
  let added = 0;
  for (const item of reply.claims) {
    const index = newClaims.findIndex((c) => c.n === item.n);
    const claim = newClaims[index]!;
    const embedding = claimEmbeddings[index]!;
    if (!item.supersedes && !item.conflicts_with) {
      const dup = await db.query(
        `select 1 from claims c
         where c.event_id = $1 and c.kind = $2 and c.superseded_by is null and not (${hiddenClaim('c')})
           and 1 - (c.embedding <=> $3::vector) >= $4 limit 1`,
        [eventId, claim.kind, vec(embedding), CLAIM_DUP_COSINE],
      );
      if (dup.rowCount) continue;
    }
    const id = await insertClaim(eventId, claim, embedding, item.conflicts_with ? unpid(item.conflicts_with) : null);
    if (item.supersedes) await db.query('update claims set superseded_by = $2 where id = $1', [unpid(item.supersedes), id]);
    added++;
  }
  await finish(eventId);
  await recomputeContentEmbedding(db, eventId);
  return { eventId, outcome: 'merged', newClaims: added, newLinks: 0 };
}

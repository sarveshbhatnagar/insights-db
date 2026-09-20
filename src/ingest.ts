import { CLAIM_DUP_COSINE, NEAR_DUP_WINDOW_DAYS, SIMHASH_MAX_HAMMING } from './config.ts';
import { type Db, documentDate, hiddenClaim, liveClaim, locked, pool, vec } from './db.ts';
import { type Candidate, consolidate, type ConsolidateReply, findCandidates, type NewClaim } from './consolidate.ts';
import { fromSigned64, hamming, normalize, sha256, simhash, toSigned64 } from './dedup.ts';
import { resolveEntities } from './entities.ts';
import { type DocumentRow, extract } from './extract.ts';
import { linkEvent } from './link.ts';
import { embed, trackUsage, type Usage } from './llm.ts';
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
  usage: Usage;
};

export type IngestOptions = { concurrency?: number | undefined };

const NO_USAGE: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };

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
  const [result] = await ingestMany([doc], { concurrency: 1 });
  return result!;
}

// Step 1 runs for every document in order under the write lock, so a repeat
// inside one batch is a duplicate of the first copy; steps 2 to 7 then run
// concurrently. Invalid input rejects the whole batch before anything is stored.
export async function ingestMany(docs: DocumentIn[], opts: IngestOptions = {}): Promise<IngestResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const parsed = docs.map((doc, i) => {
    if (typeof doc.body !== 'string' || !doc.body.trim()) throw new Error(`document ${i}: body is required and must be non-empty`);
    try {
      return parsePublishedAt(doc.publishedAt);
    } catch (err) {
      throw new Error(`document ${i}: ${(err as Error).message}`);
    }
  });

  const results = new Array<IngestResult>(docs.length);
  const pending: { index: number; row: DocumentRow }[] = [];
  for (const [i, doc] of docs.entries()) {
    const admitted = await admit(doc, parsed[i]!);
    if ('duplicate' in admitted) results[i] = admitted.duplicate;
    else pending.push({ index: i, row: admitted.row });
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (next < pending.length) {
        const { index, row } = pending[next++]!;
        results[index] = await runPipeline(row);
      }
    }),
  );

  // A duplicate admitted while its original was still in flight has no event yet.
  const dupIds = results.filter((r) => r.outcome === 'duplicate' && r.eventId === null).map((r) => r.documentId);
  if (dupIds.length > 0) {
    const { rows } = await pool.query<{ id: string; event_id: string | null }>(
      `update documents d set event_id = o.event_id from documents o
       where d.id = any($1::bigint[]) and o.id = d.duplicate_of and o.event_id is not null
       returning d.id, d.event_id`,
      [dupIds],
    );
    for (const r of results) {
      const filled = rows.find((x) => x.id === r.documentId);
      if (filled) r.eventId = filled.event_id;
    }
  }
  return results;
}

async function admit(
  doc: DocumentIn,
  publishedAt: Date | null,
): Promise<{ duplicate: IngestResult } | { row: DocumentRow }> {
  const hash = sha256(normalize(`${doc.title ?? ''} ${doc.body}`));
  const sim = simhash(normalize(doc.body));
  return locked(async (db) => {
    // Failed documents are not originals, so they can be re-ingested.
    const stored = await db.query<{ id: string; event_id: string | null; simhash: string; exact: boolean }>(
      `select id, event_id, simhash, content_hash = $1 as exact from documents
       where duplicate_of is null and error is null
         and (content_hash = $1
              or ${documentDate('documents')} between $2::timestamptz - $3 * interval '1 day'
                                                  and $2::timestamptz + $3 * interval '1 day')
       order by content_hash = $1 desc, id`,
      [hash, publishedAt ?? new Date(), NEAR_DUP_WINDOW_DAYS],
    );
    const original = stored.rows.find((r) => r.exact || hamming(fromSigned64(r.simhash), sim) <= SIMHASH_MAX_HAMMING);
    const inserted = await db.query<{ id: string; document_date: Date }>(
      `insert into documents (url, source, title, body, published_at, content_hash, simhash, duplicate_of, event_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id, ${documentDate('documents')} as document_date`,
      [doc.url ?? null, doc.source ?? null, doc.title ?? null, doc.body, publishedAt, hash, toSigned64(sim),
        original?.id ?? null, original?.event_id ?? null],
    );
    const documentId = inserted.rows[0]!.id;
    if (original) {
      return { duplicate: { documentId, eventId: original.event_id, outcome: 'duplicate', newClaims: 0, newLinks: 0, usage: NO_USAGE } };
    }
    return {
      row: { id: documentId, title: doc.title ?? null, body: doc.body, source: doc.source ?? null, documentDate: inserted.rows[0]!.document_date },
    };
  });
}

// Steps 2 to 7 for one stored document. Extraction and the consolidate and
// link judgments run outside the write lock; the write itself re-checks the
// candidates under the lock and asks again if another document changed them.
export async function runPipeline(row: DocumentRow, excludeEventId?: string): Promise<IngestResult> {
  const { result, usage } = await trackUsage(async (): Promise<Omit<IngestResult, 'documentId' | 'usage'>> => {
    let written: Written;
    try {
      written = await consolidateAndWrite(row, excludeEventId);
    } catch (err) {
      await pool.query('update documents set error = $2 where id = $1', [row.id, (err as Error).message]);
      return { eventId: null, outcome: 'failed', newClaims: 0, newLinks: 0 };
    }
    // The event is stored either way; a link failure is recorded, not fatal.
    let newLinks = 0;
    try {
      if (written.outcome === 'new') newLinks = await linkEvent(written.eventId, written.rejected);
      else if (written.newClaims > 0) newLinks = await linkEvent(written.eventId, [], true);
      await pool.query('update documents set error = null where id = $1', [row.id]);
    } catch (err) {
      await pool.query('update documents set error = $2 where id = $1', [row.id, `link: ${(err as Error).message}`]);
    }
    return { eventId: written.eventId, outcome: written.outcome, newClaims: written.newClaims, newLinks };
  });
  return { documentId: row.id, ...result, usage };
}

type Written = { eventId: string; outcome: 'new' | 'merged'; newClaims: number; rejected: string[] };

const fingerprint = (candidates: Candidate[]): string =>
  candidates.map((c) => `${c.id}:${c.claims.map((x) => x.id).join(',')}`).sort().join('|');

async function consolidateAndWrite(row: DocumentRow, excludeEventId: string | undefined): Promise<Written> {
  const extraction = await extract(row);
  const entities = await locked((db) => resolveEntities(db, extraction.entities, extraction.title));
  const newClaims: NewClaim[] = [
    ...extraction.claims.map((text) => ({ text, kind: 'fact' as const })),
    ...extraction.speculation.map((text) => ({ text, kind: 'speculation' as const })),
  ].map((c, i) => ({ ...c, n: pid('N', i + 1) }));
  const [contentEmbedding, patternEmbedding, ...claimEmbeddings] = await embed([
    contentText(extraction.title, extraction.claims),
    extraction.pattern,
    ...newClaims.map((c) => c.text),
  ]);
  const search = {
    documentDate: row.documentDate,
    entityIds: entities.map((e) => e.entityId),
    embedding: contentEmbedding!,
    exclude: excludeEventId,
  };
  const decide = (candidates: Candidate[]): Promise<ConsolidateReply> =>
    candidates.length > 0
      ? consolidate(extraction, extraction.entities.map((e) => e.name), row.documentDate, newClaims, candidates)
      : Promise.resolve({ event_id: null, claims: [] });

  let candidates = await findCandidates(pool, search);
  let reply = await decide(candidates);

  return locked(async (db) => {
    const current = await findCandidates(db, search);
    if (fingerprint(current) !== fingerprint(candidates)) {
      candidates = current;
      reply = await decide(candidates);
    }

    const insertClaim = async (eventId: string, claim: NewClaim, embedding: number[], conflictsWith: string | null): Promise<string> => {
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
      const event = await db.query<{ id: string }>(
        `insert into events (title, event_type, pattern, occurred_at, content_embedding, pattern_embedding)
         values ($1, $2, $3, $4, $5::vector, $6::vector) returning id`,
        [extraction.title, extraction.event_type, extraction.pattern, extraction.occurred_at,
          vec(contentEmbedding!), vec(patternEmbedding!)],
      );
      const eventId = event.rows[0]!.id;
      for (const [i, claim] of newClaims.entries()) await insertClaim(eventId, claim, claimEmbeddings[i]!, null);
      await finish(eventId);
      return { eventId, outcome: 'new', newClaims: newClaims.length, rejected: candidates.map((c) => c.id) };
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
    if (added > 0) await recomputeContentEmbedding(db, eventId);
    return { eventId, outcome: 'merged', newClaims: added, rejected: [] };
  });
}


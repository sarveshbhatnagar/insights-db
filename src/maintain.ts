import type { Connection } from './db.ts';
import type { DocumentRow } from './extract.ts';
import { type IngestOptions, type IngestResult, recomputeContentEmbedding, runPipeline } from './ingest.ts';
import { linkEvent } from './link.ts';

// Re-judges an event's connections against events it is not yet linked to,
// for example after it gained claims. Returns the links inserted.
export const relink = (conn: Connection, eventId: string): Promise<number> => linkEvent(conn, eventId, [], true);

// Re-runs failed documents in place: steps 2 to 7 for a document with no event,
// the link step alone for one whose only failure was there.
export async function retryFailed(conn: Connection, opts: IngestOptions & { limit?: number | undefined } = {}): Promise<IngestResult[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const { rows } = await conn.pool.query<{
    id: string; title: string | null; body: string; source: string | null; document_date: Date; event_id: string | null;
  }>(
    `select id, title, body, source, coalesce(published_at, ingested_at) as document_date, event_id
     from documents where error is not null and duplicate_of is null order by id limit $1`,
    [opts.limit ?? 100],
  );
  const results = new Array<IngestResult>(rows.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (next < rows.length) {
        const i = next++;
        const d = rows[i]!;
        const row: DocumentRow = { id: d.id, title: d.title, body: d.body, source: d.source, documentDate: d.document_date };
        if (d.event_id === null) {
          await conn.pool.query('update documents set error = null where id = $1', [d.id]);
          results[i] = await runPipeline(conn, row);
        } else {
          let newLinks = 0;
          try {
            newLinks = await relink(conn, d.event_id);
            await conn.pool.query('update documents set error = null where id = $1', [d.id]);
          } catch (err) {
            await conn.pool.query('update documents set error = $2 where id = $1', [d.id, `link: ${(err as Error).message}`]);
          }
          results[i] = { documentId: d.id, eventId: d.event_id, outcome: 'merged', newClaims: 0, newLinks,
            usage: { calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 } };
        }
      }
    }),
  );
  return results;
}

export async function mergeEntities(conn: Connection, keepId: string, dropId: string): Promise<void> {
  if (keepId === dropId) throw new Error('keepId and dropId are the same entity');
  await conn.withTransaction(async (db) => {
    const drop = await db.query<{ name: string; aliases: string[] }>('select name, aliases from entities where id = $1', [dropId]);
    if (!drop.rows[0]) throw new Error(`no entity ${dropId}`);
    await db.query(
      `update event_entities set entity_id = $1 where entity_id = $2
       and not exists (select 1 from event_entities k where k.entity_id = $1 and k.event_id = event_entities.event_id)`,
      [keepId, dropId],
    );
    await db.query('delete from event_entities where entity_id = $1', [dropId]);
    await db.query(
      `update entities set aliases = array(
         select distinct a from unnest(aliases || $2::text[]) a where lower(a) <> lower(name) order by a)
       where id = $1`,
      [keepId, [drop.rows[0].name, ...drop.rows[0].aliases]],
    );
    await db.query('delete from entities where id = $1', [dropId]);
  });
}

export async function detachDocument(conn: Connection, documentId: string): Promise<IngestResult> {
  const row = await conn.withTransaction(async (db) => {
    const doc = await db.query<{
      id: string; title: string | null; body: string; source: string | null; document_date: Date; event_id: string | null;
    }>(
      `select id, title, body, source, coalesce(published_at, ingested_at) as document_date, event_id
       from documents where id = $1`,
      [documentId],
    );
    const d = doc.rows[0];
    if (!d) throw new Error(`no document ${documentId}`);
    if (!d.event_id) throw new Error(`document ${documentId} is not attached to an event`);
    const eventId = d.event_id;

    await db.query(
      `update claims set superseded_by = null where superseded_by in (select id from claims where document_id = $1)`,
      [documentId],
    );
    await db.query(
      `update claims set conflicts_with = null where conflicts_with in (select id from claims where document_id = $1)`,
      [documentId],
    );
    await db.query('delete from claims where document_id = $1', [documentId]);
    await db.query('update documents set event_id = null where id = $1 or duplicate_of = $1', [documentId]);

    const left = await db.query<{ claims: string; documents: string }>(
      `select (select count(*) from claims where event_id = $1) as claims,
              (select count(*) from documents where event_id = $1) as documents`,
      [eventId],
    );
    if (left.rows[0]!.claims === '0' && left.rows[0]!.documents === '0') {
      const s = await db.query<{ storyline_id: string | null }>('select storyline_id from events where id = $1', [eventId]);
      await db.query('delete from links where src = $1 or dst = $1', [eventId]);
      await db.query('delete from event_entities where event_id = $1', [eventId]);
      await db.query('delete from events where id = $1', [eventId]);
      const storylineId = s.rows[0]!.storyline_id;
      if (storylineId) {
        const rest = await db.query('select id from events where storyline_id = $1', [storylineId]);
        if (rest.rowCount! <= 1) {
          await db.query('update events set storyline_id = null where storyline_id = $1', [storylineId]);
          await db.query('delete from storylines where id = $1', [storylineId]);
        }
      }
    } else {
      await recomputeContentEmbedding(db, eventId);
    }
    const row: DocumentRow = { id: d.id, title: d.title, body: d.body, source: d.source, documentDate: d.document_date };
    return { row, eventId };
  });

  // The extraction was never stored, so the re-run starts at step 2.
  const result = await runPipeline(conn, row.row, row.eventId);
  if (result.eventId) {
    await conn.pool.query('update documents set event_id = $2 where duplicate_of = $1', [documentId, result.eventId]);
  }
  return result;
}

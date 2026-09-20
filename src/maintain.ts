import { pool, withTransaction } from './db.ts';
import type { DocumentRow } from './extract.ts';
import { type IngestResult, recomputeContentEmbedding, runPipeline } from './ingest.ts';

export async function mergeEntities(keepId: string, dropId: string): Promise<void> {
  if (keepId === dropId) throw new Error('keepId and dropId are the same entity');
  await withTransaction(async (db) => {
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

export async function detachDocument(documentId: string): Promise<IngestResult> {
  const row = await withTransaction(async (db) => {
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
  const result = await runPipeline(row.row, row.eventId);
  if (result.eventId) {
    await pool.query('update documents set event_id = $2 where duplicate_of = $1', [documentId, result.eventId]);
  }
  return result;
}

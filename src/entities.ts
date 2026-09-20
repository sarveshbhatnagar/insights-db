import { z } from 'zod';
import { ENTITY_NEIGHBOR_MIN } from './config.ts';
import { type Db, vec } from './db.ts';
import type { Extraction } from './extract.ts';
import { completeJson, embed } from './llm.ts';
import { idEnum, pid, render, unpid } from './prompts.ts';

type ExtractedEntity = Extraction['entities'][number];

export async function resolveEntities(
  db: Db,
  entities: ExtractedEntity[],
  eventTitle: string,
): Promise<{ entityId: string; role: string }[]> {
  // Two extracted names may resolve to one entity; the first role wins.
  const roles = new Map<string, string>();
  for (const entity of entities) {
    const id = await resolveEntity(db, entity, eventTitle);
    if (!roles.has(id)) roles.set(id, entity.role);
  }
  return [...roles].map(([entityId, role]) => ({ entityId, role }));
}

async function resolveEntity(db: Db, entity: ExtractedEntity, eventTitle: string): Promise<string> {
  const exact = await db.query<{ id: string }>(
    `select id from entities
     where type = $1 and (lower(name) = lower($2)
        or exists (select 1 from unnest(aliases) a where lower(a) = lower($2)))
     order by id limit 1`,
    [entity.type, entity.name],
  );
  if (exact.rows[0]) return exact.rows[0].id;

  const [embedding] = await embed([entity.name]);
  const v = vec(embedding!);
  const near = await db.query<{ id: string; name: string; aliases: string[] }>(
    `select id, name, aliases from entities
     where type = $1 and 1 - (embedding <=> $2::vector) >= $3
     order by embedding <=> $2::vector limit 3`,
    [entity.type, v, ENTITY_NEIGHBOR_MIN],
  );
  if (near.rows.length > 0) {
    const ids = near.rows.map((r) => pid('T', r.id));
    const candidates = near.rows
      .map((r) => `${pid('T', r.id)} | ${r.name} | ${entity.type} | also known as: ${r.aliases.join(', ')}`)
      .join('\n');
    const user = await render('resolve_entity', {
      name: entity.name,
      type: entity.type,
      event_title: eventTitle,
      candidates,
    });
    const reply = await completeJson(await render('shared'), user, z.strictObject({ match: idEnum(ids).nullable() }));
    if (reply.match) {
      const id = unpid(reply.match);
      await db.query(
        `update entities set aliases = array_append(aliases, $2)
         where id = $1 and lower(name) <> lower($2)
           and not exists (select 1 from unnest(aliases) a where lower(a) = lower($2))`,
        [id, entity.name],
      );
      return id;
    }
  }
  const inserted = await db.query<{ id: string }>(
    'insert into entities (name, type, embedding) values ($1, $2, $3::vector) returning id',
    [entity.name, entity.type, v],
  );
  return inserted.rows[0]!.id;
}

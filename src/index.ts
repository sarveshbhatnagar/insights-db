import { Connection, type ConnectionOptions } from './db.ts';
import * as events from './events.ts';
import * as ingestion from './ingest.ts';
import * as maintenance from './maintain.ts';
import * as prompts from './prompts.ts';
import * as queries from './query.ts';

export type { DocumentIn, IngestOptions, IngestResult } from './ingest.ts';
export type {
  AsOf, Claim, EntityStats, EventEntity, EventFilters, EventRecord, ListQuery, Page, SimilarQuery, TypeStats, Vector,
} from './events.ts';
export type {
  Citation, ClaimHit, EntityHit, EventDetail, EventHit, GetEventOptions, SimilarEvent,
} from './query.ts';
export type { Step } from './prompts.ts';
export type { Usage } from './llm.ts';
export type { ConnectionOptions } from './db.ts';

// A module function with its first argument fixed to this connection.
type Bound<F> = F extends (conn: Connection, ...args: infer A) => infer R ? (...args: A) => R : never;
const bind = <F extends (conn: Connection, ...args: never[]) => unknown>(conn: Connection, fn: F): Bound<F> =>
  ((...args: never[]) => fn(conn, ...args)) as Bound<F>;

// One database, with the public functions as methods and the read API under
// `events`. Open several to work with several databases; `end()` closes the pool.
export class Insights extends Connection {
  readonly ingest = bind(this, ingestion.ingest);
  readonly ingestMany = bind(this, ingestion.ingestMany);
  readonly retryFailed = bind(this, maintenance.retryFailed);
  readonly relink = bind(this, maintenance.relink);
  readonly mergeEntities = bind(this, maintenance.mergeEntities);
  readonly detachDocument = bind(this, maintenance.detachDocument);
  readonly ask = bind(this, queries.ask);
  readonly getEvent = bind(this, queries.getEvent);
  readonly getStoryline = bind(this, queries.getStoryline);
  readonly similarEvents = bind(this, queries.similarEvents);
  readonly searchEvents = bind(this, queries.searchEvents);
  readonly listClaims = bind(this, queries.listClaims);
  readonly listEntities = bind(this, queries.listEntities);
  readonly setGuidance = bind(this, prompts.setGuidance);
  readonly getGuidance = bind(this, prompts.getGuidance);
  // Events as records with no LLM call: by id, by page, by similarity, and the type and entity catalogs.
  readonly events = {
    getMany: bind(this, events.getMany),
    list: bind(this, events.list),
    similar: bind(this, events.similar),
    types: bind(this, events.types),
    entities: bind(this, events.entities),
  };
}

export function openInsights(opts: ConnectionOptions = {}): Insights {
  return new Insights(opts);
}

// The functions below run against DATABASE_URL, opened on first use, for
// callers that never open a handle themselves.
let shared: Insights | undefined;
const db = (): Insights => (shared ??= openInsights());

export const init: Insights['init'] = () => db().init();
export const ingest: Insights['ingest'] = (...a) => db().ingest(...a);
export const ingestMany: Insights['ingestMany'] = (...a) => db().ingestMany(...a);
export const retryFailed: Insights['retryFailed'] = (...a) => db().retryFailed(...a);
export const relink: Insights['relink'] = (...a) => db().relink(...a);
export const mergeEntities: Insights['mergeEntities'] = (...a) => db().mergeEntities(...a);
export const detachDocument: Insights['detachDocument'] = (...a) => db().detachDocument(...a);
export const ask: Insights['ask'] = (...a) => db().ask(...a);
export const getEvent: Insights['getEvent'] = (...a) => db().getEvent(...a);
export const getStoryline: Insights['getStoryline'] = (...a) => db().getStoryline(...a);
export const similarEvents: Insights['similarEvents'] = (...a) => db().similarEvents(...a);
export const searchEvents: Insights['searchEvents'] = (...a) => db().searchEvents(...a);
export const listClaims: Insights['listClaims'] = (...a) => db().listClaims(...a);
export const listEntities: Insights['listEntities'] = (...a) => db().listEntities(...a);
export const setGuidance: Insights['setGuidance'] = (...a) => db().setGuidance(...a);
export const getGuidance: Insights['getGuidance'] = (...a) => db().getGuidance(...a);

export { ingest, ingestMany, type DocumentIn, type IngestOptions, type IngestResult } from './ingest.ts';
export {
  ask, getEvent, getStoryline, similarEvents, searchEvents, listClaims, listEntities,
  type Citation, type Claim, type ClaimHit, type EntityHit, type EventDetail, type EventHit,
} from './query.ts';
export { getGuidance, setGuidance, type Step } from './prompts.ts';
export { detachDocument, mergeEntities, relink, retryFailed } from './maintain.ts';
export { init } from './db.ts';
export type { Usage } from './llm.ts';

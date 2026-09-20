import { z } from 'zod';
import { completeJson } from './llm.ts';
import { isoDate, maxWords, render } from './prompts.ts';

export const EntityType = z.enum(['person', 'org', 'place', 'other']);

export const ExtractionSchema = z.strictObject({
  title: maxWords(15),
  event_type: z.string().regex(/^[a-z][a-z0-9]*(_[a-z0-9]+){0,2}$/, 'snake_case, 1-3 words'),
  pattern: maxWords(25),
  occurred_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  entities: z
    .array(z.strictObject({ name: z.string().trim().min(1), type: EntityType, role: maxWords(3) }))
    .max(8),
  claims: z.array(maxWords(30)).max(10),
  speculation: z.array(maxWords(30)).max(5),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export type DocumentRow = {
  id: string;
  title: string | null;
  body: string;
  source: string | null;
  documentDate: Date;
};

export async function extract(doc: DocumentRow): Promise<Extraction> {
  const user = await render('extract', {
    source: doc.source ?? undefined,
    document_date: isoDate(doc.documentDate),
    title: doc.title ?? undefined,
    body: doc.body,
  });
  return completeJson(await render('shared'), user, ExtractionSchema);
}

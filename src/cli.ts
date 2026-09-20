#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { openInsights } from './index.ts';

const usage = `usage:
  insights-db init                             create or update the schema
  insights-db ingest <file.jsonl> [--concurrency 4]   one DocumentIn per line
  insights-db retry [--concurrency 4]          re-run failed documents
  insights-db ask "<question>"
  insights-db search "<query>" [--k 8]         events, no LLM
  insights-db claims "<query>" [--speculation] [--k 20]
  insights-db entities "<query>" [--k 20]
  insights-db similar <eventId> [--k 5]
  insights-db relink <eventId>                 re-judge an event's links
  insights-db guidance <file.json>             {step: text}; null removes a step's guidance`;

const json = (v: unknown): void => console.log(JSON.stringify(v, null, 2));

const db = openInsights();

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { k: { type: 'string' }, concurrency: { type: 'string' }, speculation: { type: 'boolean' } },
  });
  const [command, arg] = positionals;
  const k = values.k ? Number(values.k) : undefined;
  const concurrency = values.concurrency ? Number(values.concurrency) : undefined;
  switch (command) {
    case 'init':
      await db.init();
      return 0;
    case 'retry':
      json(await db.retryFailed({ concurrency }));
      return 0;
  }
  if (!command || !arg) {
    console.error(usage);
    return 2;
  }
  switch (command) {
    case 'ingest': {
      const docs = readFileSync(arg, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      for (const r of await db.ingestMany(docs, { concurrency })) console.log(JSON.stringify(r));
      return 0;
    }
    case 'ask': {
      const { answer, citations } = await db.ask(arg);
      console.log(answer);
      for (const c of citations) {
        console.log(`\n[C${c.claimId}] ${c.text}\n  ${[c.source, c.url, c.publishedAt.toISOString().slice(0, 10)].filter(Boolean).join(' · ')}`);
      }
      return 0;
    }
    case 'search':
      json(await db.searchEvents(arg, { k }));
      return 0;
    case 'claims':
      json(await db.listClaims({ query: arg, k, speculation: values.speculation ? true : undefined }));
      return 0;
    case 'entities':
      json(await db.listEntities({ query: arg, k }));
      return 0;
    case 'similar':
      json(await db.similarEvents(arg, k ?? 5));
      return 0;
    case 'relink':
      json({ newLinks: await db.relink(arg) });
      return 0;
    case 'guidance': {
      const steps = JSON.parse(readFileSync(arg, 'utf8')) as Record<string, string | null>;
      for (const [step, text] of Object.entries(steps)) await db.setGuidance(step, text);
      return 0;
    }
    default:
      console.error(usage);
      return 2;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: Error) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());

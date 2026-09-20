#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pool } from './db.ts';
import { ask, ingest, setGuidance, similarEvents } from './index.ts';

const usage = `usage:
  insights-db ingest <file.jsonl>   one DocumentIn per line
  insights-db ask "<question>"
  insights-db similar <eventId> [--k 5]
  insights-db guidance <file.json>  {step: text}; null removes a step's guidance`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { k: { type: 'string' } } });
  const [command, arg] = positionals;
  if (!command || !arg) {
    console.error(usage);
    return 2;
  }
  switch (command) {
    case 'ingest': {
      const lines = readFileSync(arg, 'utf8').split('\n').filter((l) => l.trim());
      for (const line of lines) console.log(JSON.stringify(await ingest(JSON.parse(line))));
      return 0;
    }
    case 'ask': {
      const { answer, citations } = await ask(arg);
      console.log(answer);
      for (const c of citations) {
        console.log(`\n[C${c.claimId}] ${c.text}\n  ${[c.source, c.url, c.publishedAt.toISOString().slice(0, 10)].filter(Boolean).join(' · ')}`);
      }
      return 0;
    }
    case 'similar':
      console.log(JSON.stringify(await similarEvents(arg, values.k ? Number(values.k) : 5), null, 2));
      return 0;
    case 'guidance': {
      const steps = JSON.parse(readFileSync(arg, 'utf8')) as Record<string, string | null>;
      for (const [step, text] of Object.entries(steps)) await setGuidance(step, text);
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
  .finally(() => pool.end());

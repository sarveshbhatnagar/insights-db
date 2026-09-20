import { createHash } from 'node:crypto';
import { EMBED_DIM } from '../src/config.ts';
import { stepOf } from '../src/prompts.ts';

type Message = { role: string; content?: string | null; tool_calls?: unknown[] };
type ToolCall = { name: string; args: unknown };
export type FakeReply = string | Record<string, unknown> | { tool_calls: ToolCall[] };
type Call = { step: string; messages: Message[]; tools: { function: { name: string } }[] | undefined };

// Words map to fixed pseudo-random unit vectors and a text embeds as their
// normalized sum, so shared wording means high cosine. Aliases let a fixture
// declare two phrases identical ("the Fed" ~ "Federal Reserve").
const wordVectors = new Map<string, Float64Array>();
function wordVector(word: string): Float64Array {
  let v = wordVectors.get(word);
  if (v) return v;
  v = new Float64Array(EMBED_DIM);
  let seed = createHash('sha256').update(word).digest();
  for (let i = 0; i < EMBED_DIM; i++) {
    if (i % 32 === 0) seed = createHash('sha256').update(seed).digest();
    v[i] = seed[i % 32]! / 128 - 1;
  }
  wordVectors.set(word, v);
  return v;
}

function fakeEmbedding(text: string): number[] {
  let t = text.toLowerCase();
  for (const [from, to] of fake.aliases) t = t.replaceAll(from.toLowerCase(), to.toLowerCase());
  const words = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const sum = new Float64Array(EMBED_DIM);
  for (const w of words) {
    const v = wordVector(w);
    for (let i = 0; i < EMBED_DIM; i++) sum[i]! += v[i]!;
  }
  const norm = Math.hypot(...sum) || 1;
  return Array.from(sum, (x) => x / norm);
}

let callId = 0;

class Completions {
  async create(req: { messages: Message[]; tools?: { function: { name: string } }[] }) {
    const system = req.messages[0]?.content ?? '';
    const user = req.messages[1]?.content ?? '';
    const step = stepOf(String(system), String(user));
    fake.calls.push({ step, messages: req.messages, tools: req.tools });
    // Keyed replies first (needed when calls arrive in any order), then the FIFO queue.
    const keyed = (fake.keyed.get(step) ?? []).find((k) => String(user).includes(k.includes) && k.replies.length > 0);
    const reply = keyed ? keyed.replies.shift() : (fake.replies.get(step) ?? []).shift();
    if (reply === undefined) throw new Error(`fake LLM: no reply queued for step ${step}`);
    const message: Record<string, unknown> = { role: 'assistant', content: null };
    if (typeof reply === 'string') message.content = reply;
    else if ('tool_calls' in reply && Array.isArray(reply.tool_calls)) {
      message.tool_calls = (reply.tool_calls as ToolCall[]).map((c) => ({
        id: `call_${++callId}`,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
    } else message.content = JSON.stringify(reply);
    return { choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
  }
}

class Embeddings {
  async create(req: { input: string[] }) {
    fake.embedded.push(...req.input);
    return {
      data: req.input.map((text, index) => ({ index, embedding: fakeEmbedding(text) })),
      usage: { prompt_tokens: req.input.length },
    };
  }
}

class FakeOpenAI {
  chat = { completions: new Completions() };
  embeddings = new Embeddings();
}

export const fake = {
  OpenAI: FakeOpenAI,
  replies: new Map<string, FakeReply[]>(),
  keyed: new Map<string, { includes: string; replies: FakeReply[] }[]>(),
  calls: [] as Call[],
  embedded: [] as string[],
  aliases: new Map<string, string>(),
  reply(step: string, ...replies: FakeReply[]): void {
    fake.replies.set(step, [...(fake.replies.get(step) ?? []), ...replies]);
  },
  // Replies served to any call of `step` whose prompt contains `includes`.
  when(step: string, includes: string, ...replies: FakeReply[]): void {
    fake.keyed.set(step, [...(fake.keyed.get(step) ?? []), { includes, replies }]);
  },
  alias(from: string, to: string): void {
    fake.aliases.set(from, to);
  },
  reset(): void {
    fake.replies.clear();
    fake.keyed.clear();
    fake.calls.length = 0;
    fake.embedded.length = 0;
    fake.aliases.clear();
  },
  // Every text sent to the model so far, for "the agent never saw X" assertions.
  transcript(): string {
    return fake.calls.map((c) => c.messages.map((m) => String(m.content ?? '')).join('\n')).join('\n');
  },
  embedding: fakeEmbedding,
};

import { channel } from 'node:diagnostics_channel';
import { debuglog } from 'node:util';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { z } from 'zod';
import { EMBED_DIM, EMBED_MODEL, LLM_BASE_URL, LLM_MODEL, LLM_MODEL_BY_STEP } from './config.ts';
import { stepOf } from './prompts.ts';

export type Tool = {
  name: string;
  description: string;
  parameters: z.ZodType;
  run: (args: never) => Promise<unknown>;
};

// Token usage goes out on a diagnostics channel so eval/ can total it without
// this module exporting anything beyond its three functions.
const usage = channel('insights-db:llm');
const log = debuglog('insights-db');

const missing = (name: string): never => {
  throw new Error(`${name} is not set`);
};
let chatClient: OpenAI | undefined;
let embedClient: OpenAI | undefined;
const chat = (): OpenAI =>
  (chatClient ??= new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY ?? missing('DEEPSEEK_API_KEY'), baseURL: LLM_BASE_URL }));
const embedder = (): OpenAI =>
  (embedClient ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? missing('OPENAI_API_KEY') }));

async function complete(step: string, messages: ChatCompletionMessageParam[], tools?: ChatCompletionTool[]) {
  const wantsJson = messages.some((m) => typeof m.content === 'string' && /json/i.test(m.content));
  const res = await chat().chat.completions.create({
    model: LLM_MODEL_BY_STEP[step] ?? LLM_MODEL,
    temperature: 0,
    messages,
    ...(tools && tools.length > 0 ? { tools } : wantsJson ? { response_format: { type: 'json_object' } } : {}),
  });
  const inputTokens = res.usage?.prompt_tokens ?? 0;
  const reasoningTokens = res.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const outputTokens = (res.usage?.completion_tokens ?? 0) - reasoningTokens;
  usage.publish({ step, inputTokens, outputTokens, reasoningTokens });
  log('%s in=%d out=%d reasoning=%d', step, inputTokens, outputTokens, reasoningTokens);
  const message = res.choices[0]?.message;
  if (!message) throw new Error(`${step}: empty completion`);
  log('%s prompt:\n%s\n%s reply: %s', step, messages.at(-1)?.content, step, message.content ?? JSON.stringify(message.tool_calls));
  return message;
}

function parseReply<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return { ok: false, error: 'no JSON object in reply' };
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  const result = schema.safeParse(data);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: z.prettifyError(result.error) };
}

const retryMessage = (error: string): string =>
  `Your reply was invalid:\n${error}\nReply again with only the corrected JSON object.`;

export async function completeJson<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T> {
  const step = stepOf(system, user);
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let error = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = (await complete(step, messages)).content ?? '';
    const parsed = parseReply(text, schema);
    if (parsed.ok) return parsed.value;
    error = parsed.error;
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: retryMessage(error) });
  }
  throw new Error(`${step}: invalid reply after retry: ${error}`);
}

export async function runTools<T>(
  system: string,
  user: string,
  tools: Tool[],
  schema: z.ZodType<T>,
  maxCalls: number,
): Promise<T> {
  const step = stepOf(system, user);
  const defs: ChatCompletionTool[] = tools.map((t) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(t.parameters);
    return { type: 'function', function: { name: t.name, description: t.description, parameters } };
  });
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  let calls = 0;
  let retried = false;
  for (;;) {
    const message = await complete(step, messages, calls < maxCalls ? defs : undefined);
    const toolCalls = message.tool_calls?.filter((c) => c.type === 'function') ?? [];
    if (toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: message.content, tool_calls: toolCalls });
      for (const call of toolCalls) {
        const tool = tools.find((t) => t.name === call.function.name);
        let result: unknown;
        if (calls >= maxCalls) result = { error: 'tool call budget exhausted; answer now' };
        else if (!tool) result = { error: `unknown tool ${call.function.name}` };
        else {
          calls++;
          try {
            const args = tool.parameters.safeParse(JSON.parse(call.function.arguments || '{}'));
            result = args.success ? await tool.run(args.data as never) : { error: z.prettifyError(args.error) };
          } catch (err) {
            result = { error: (err as Error).message };
          }
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }
    const text = message.content ?? '';
    const parsed = parseReply(text, schema);
    if (parsed.ok) return parsed.value;
    if (retried) throw new Error(`${step}: invalid reply after retry: ${parsed.error}`);
    retried = true;
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: retryMessage(parsed.error) });
  }
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await embedder().embeddings.create({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIM });
  usage.publish({ step: 'embed', inputTokens: res.usage.prompt_tokens, outputTokens: 0 });
  return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

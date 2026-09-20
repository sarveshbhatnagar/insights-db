import { vi } from 'vitest';
import { fake } from './fake.ts';

// The SDK is mocked, but llm.ts still insists on keys before constructing a client.
process.env.DEEPSEEK_API_KEY ??= 'test';
process.env.OPENAI_API_KEY ??= 'test';

vi.mock('openai', () => ({ default: fake.OpenAI }));

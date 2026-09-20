import { vi } from 'vitest';
import { fake } from './fake.ts';

vi.mock('openai', () => ({ default: fake.OpenAI }));

export const EMBED_DIM = 1536;

// DeepSeek speaks the OpenAI chat protocol but has no embedding endpoint, so
// embeddings come from OpenAI through the same SDK.
export const LLM_BASE_URL = 'https://api.deepseek.com';
export const LLM_MODEL = 'deepseek-chat';
// Steps whose judgment the cheap model gets wrong in eval run on the reasoning
// model; its reasoning tokens are discarded and not counted against budgets.
export const LLM_MODEL_BY_STEP: Record<string, string> = { link: 'deepseek-reasoner' };
export const EMBED_MODEL = 'text-embedding-3-small';

export const SIMHASH_MAX_HAMMING = 3;
export const NEAR_DUP_WINDOW_DAYS = 7;
export const ENTITY_NEIGHBOR_MIN = 0.8;
export const CANDIDATE_WINDOW_DAYS = 14;
export const CANDIDATE_MIN_COSINE = 0.75;
export const CANDIDATE_MAX = 5;
export const CLAIM_DUP_COSINE = 0.92;
export const LINK_WINDOW_DAYS = 90;
export const LINK_CANDIDATE_MAX = 8;
export const QUERY_MAX_TOOL_CALLS = 8;
export const VERIFY_MODE: 'off' | 'flag' | 'strict' = 'off';
export const VERIFY_MAX_SEARCHES = 6;
export const VERIFY_WEB = false;
export const VERIFY_REFERENCE_MAX = 15;

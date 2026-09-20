create extension if not exists vector;

create table entities (
  id         bigserial primary key,
  name       text not null,
  type       text not null check (type in ('person','org','place','other')),
  aliases    text[] not null default '{}',
  embedding  vector(EMBED_DIM) not null          -- embed(name)
);

create table storylines (
  id     bigserial primary key,
  title  text not null                           -- <= 8 words, set once at creation
);

create table events (
  id                 bigserial primary key,
  storyline_id       bigint references storylines(id),  -- null = stands alone
  title              text not null,              -- <= 15 words
  event_type         text not null,              -- snake_case, 1-3 words
  pattern            text not null,              -- <= 25 words, entity-free
  occurred_at        date not null,
  content_embedding  vector(EMBED_DIM) not null, -- embed(title + live claim texts)
  pattern_embedding  vector(EMBED_DIM) not null  -- embed(pattern)
);

create table documents (
  id            bigserial primary key,
  url           text,
  source        text,
  title         text,
  body          text not null,
  published_at  timestamptz,                     -- null = unknown
  content_hash  bytea not null,                  -- sha256 of normalized title + body
  simhash       bigint not null,
  duplicate_of  bigint references documents(id),
  event_id      bigint references events(id),
  error         text,
  ingested_at   timestamptz not null default now()
);

create table event_entities (
  event_id   bigint not null references events(id),
  entity_id  bigint not null references entities(id),
  role       text not null,                      -- <= 3 words
  primary key (event_id, entity_id)
);

create table claims (
  id              bigserial primary key,
  event_id        bigint not null references events(id),
  document_id     bigint not null references documents(id),  -- first document to assert it
  text            text not null,                 -- one fact, <= 30 words
  asserted_at     timestamptz not null,          -- that document's date, see below
  superseded_by   bigint references claims(id),
  conflicts_with  bigint references claims(id),
  kind            text not null default 'fact' check (kind in ('fact','speculation')),
  verdict         text check (verdict in ('refuted','unsupported')),  -- set only by step 5a
  evidence_url    text,
  against         bigint[] not null default '{}',  -- stored claims whose figures contradict it
  embedding       vector(EMBED_DIM) not null,
  tsv             tsvector generated always as (to_tsvector('english', text)) stored
);

create table links (
  id      bigserial primary key,
  src     bigint not null references events(id),
  dst     bigint not null references events(id),
  type    text not null check (type in
            ('causes','reacts_to','contradicts','background_for')),
  reason  text not null,                         -- <= 20 words
  unique (src, dst),
  check (src <> dst)
);

create table guidance (
  step        text primary key check (step in
                ('domain','extract','resolve_entity','consolidate','verify','link','query')),
  text        text not null,                     -- <= 150 words
  updated_at  timestamptz not null default now()
);

create index on documents (content_hash);
create index on entities using hnsw (embedding vector_cosine_ops);
create index on events using hnsw (content_embedding vector_cosine_ops);
create index on events using hnsw (pattern_embedding vector_cosine_ops);
create index on claims using hnsw (embedding vector_cosine_ops);
create index on claims using gin (tsv);

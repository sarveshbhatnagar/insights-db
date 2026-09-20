import type { DocumentIn } from '../../src/ingest.ts';

// A fictional bank failure reported by three outlets, plus related events.
export const bankBody =
  'Meridian Bank, a mid-size lender based in Ohio, was closed by state regulators on Thursday after ' +
  'depositors withdrew more than 4 billion dollars in two days. The run began after the bank disclosed ' +
  'a 1.8 billion dollar loss on the sale of long-dated bonds. The Federal Deposit Insurance Corporation ' +
  'was named receiver and said insured depositors would have access to their money on Monday. ' +
  'Chief executive Dana Whitfield said the bank had been in talks to raise capital. Analysts said the ' +
  'collapse was the largest bank failure in the state since 2008.';

export const bankArticle: DocumentIn = {
  title: 'Meridian Bank collapses after two-day deposit run',
  body: bankBody,
  publishedAt: '2026-09-11T08:00:00Z',
  source: 'Wire One',
  url: 'https://wire.one/meridian',
};

export const bankExtraction = {
  title: 'Meridian Bank closed by regulators after deposit run',
  event_type: 'bank_failure',
  pattern: 'mid-size bank fails after deposit run triggered by bond losses',
  occurred_at: '2026-09-10',
  entities: [
    { name: 'Meridian Bank', type: 'org', role: 'failed bank' },
    { name: 'Federal Deposit Insurance Corporation', type: 'org', role: 'receiver' },
    { name: 'Dana Whitfield', type: 'person', role: 'chief executive' },
  ],
  claims: [
    'Meridian Bank was closed by Ohio state regulators on 2026-09-10.',
    'Depositors withdrew more than 4 billion dollars from Meridian Bank in two days.',
    'Meridian Bank disclosed a 1.8 billion dollar loss on the sale of long-dated bonds.',
    'The Federal Deposit Insurance Corporation was named receiver of Meridian Bank.',
    'Dana Whitfield said Meridian Bank had been in talks to raise capital.',
  ],
  speculation: [],
};

// Second outlet: same event, two new facts, the rest repeated in other words.
export const bankArticle2: DocumentIn = {
  title: 'Regulators seize Ohio lender Meridian after run on deposits',
  body:
    'State banking regulators in Ohio seized Meridian Bank late Thursday, appointing the FDIC as receiver, ' +
    'after customers pulled about 4 billion dollars in 48 hours. The bank had 22 billion dollars in assets ' +
    'at the end of June. Its shares were halted before the open on Thursday. The run followed a disclosure ' +
    'that the bank lost 1.8 billion dollars selling bonds to cover withdrawals.',
  publishedAt: '2026-09-11T12:00:00Z',
  source: 'Daily Ledger',
  url: 'https://ledger.example/meridian-seized',
};

export const bankExtraction2 = {
  title: 'Ohio regulators seize Meridian Bank after deposit run',
  event_type: 'bank_failure',
  pattern: 'regional bank seized by regulators after depositors flee following bond losses',
  occurred_at: '2026-09-10',
  entities: [
    { name: 'Meridian Bank', type: 'org', role: 'failed bank' },
    { name: 'FDIC', type: 'org', role: 'receiver' },
  ],
  claims: [
    'Ohio regulators seized Meridian Bank on 2026-09-10.',
    'Customers pulled about 4 billion dollars from Meridian Bank in 48 hours.',
    'Meridian Bank had 22 billion dollars in assets at the end of June 2026.',
    'Trading in Meridian Bank shares was halted before the open on 2026-09-10.',
  ],
  speculation: [],
};

// Third outlet: one new fact and one forecast.
export const bankArticle3: DocumentIn = {
  title: 'Meridian failure to cost deposit fund 2 billion, FDIC estimates',
  body:
    'The FDIC estimated the failure of Meridian Bank would cost the deposit insurance fund about 2 billion ' +
    'dollars. The Ohio bank was closed on Thursday after a two-day run. Analysts at Harbor Research said ' +
    'more regional banks could fail if rates stay high.',
  publishedAt: '2026-09-12T09:00:00Z',
  source: 'Metro Post',
  url: 'https://metro.example/meridian-cost',
};

export const bankExtraction3 = {
  title: 'FDIC estimates Meridian Bank failure will cost 2 billion dollars',
  event_type: 'bank_failure',
  pattern: 'regulator estimates cost of a bank failure to the insurance fund',
  occurred_at: '2026-09-10',
  entities: [
    { name: 'Meridian Bank', type: 'org', role: 'failed bank' },
    { name: 'Federal Deposit Insurance Corporation', type: 'org', role: 'receiver' },
  ],
  claims: [
    'The FDIC estimated the Meridian Bank failure would cost the deposit insurance fund about 2 billion dollars.',
    'Meridian Bank was closed on 2026-09-10 after a two-day run.',
  ],
  speculation: ['Harbor Research analysts said more regional banks could fail if rates stay high.'],
};

// The union of distinct facts across the three articles, in insertion order.
export const bankDistinctFacts = [
  ...bankExtraction.claims,
  bankExtraction2.claims[2]!,
  bankExtraction2.claims[3]!,
  bankExtraction3.claims[0]!,
];

// Fourth outlet: nothing new.
export const bankArticle4: DocumentIn = {
  title: 'What we know about the Meridian Bank collapse',
  body:
    'Meridian Bank of Ohio was shut by regulators on Thursday. Depositors had taken out over 4 billion dollars ' +
    'in two days after the bank revealed a 1.8 billion dollar bond loss. The FDIC is receiver.',
  publishedAt: '2026-09-12T18:00:00Z',
  source: 'Evening Standard Times',
};

export const bankExtraction4 = {
  title: 'Meridian Bank shut by Ohio regulators after deposit run',
  event_type: 'bank_failure',
  pattern: 'bank shut by regulators after a run on deposits',
  occurred_at: '2026-09-10',
  entities: [{ name: 'Meridian Bank', type: 'org', role: 'failed bank' }],
  claims: [
    'Ohio regulators shut Meridian Bank on 2026-09-10.',
    'Depositors took out over 4 billion dollars from Meridian Bank in two days.',
    'Meridian Bank revealed a 1.8 billion dollar bond loss.',
  ],
  speculation: [],
};

// A later count supersedes the withdrawal figure.
export const bankArticle5: DocumentIn = {
  title: 'Meridian withdrawals reached 6 billion, receiver says',
  body:
    'Depositors withdrew more than 6 billion dollars from Meridian Bank before it was closed, the FDIC said ' +
    'on Saturday, revising an earlier figure of 4 billion. The receiver has begun contacting bidders.',
  publishedAt: '2026-09-13T10:00:00Z',
  source: 'Wire One',
};

export const bankExtraction5 = {
  title: 'FDIC revises Meridian Bank withdrawals to more than 6 billion dollars',
  event_type: 'bank_failure',
  pattern: 'regulator revises upward the size of a deposit run at a failed bank',
  occurred_at: '2026-09-10',
  entities: [
    { name: 'Meridian Bank', type: 'org', role: 'failed bank' },
    { name: 'FDIC', type: 'org', role: 'receiver' },
  ],
  claims: [
    'Depositors withdrew more than 6 billion dollars from Meridian Bank before it was closed.',
    'The FDIC has begun contacting bidders for Meridian Bank.',
  ],
  speculation: [],
};

// A different event with the same entities.
export const saleArticle: DocumentIn = {
  title: 'Northgate Bank to buy Meridian deposits and branches from FDIC',
  body:
    'The FDIC said on Monday that Northgate Bank had agreed to assume all deposits and buy the 40 branches of ' +
    'failed Meridian Bank. Branches will reopen under the Northgate name on Tuesday.',
  publishedAt: '2026-09-15T08:00:00Z',
  source: 'Wire One',
  url: 'https://wire.one/meridian-sale',
};

export const saleExtraction = {
  title: 'Northgate Bank agrees to take over Meridian Bank deposits and branches',
  event_type: 'bank_acquisition',
  pattern: 'rival bank assumes deposits and branches of a failed bank from the regulator',
  occurred_at: '2026-09-14',
  entities: [
    { name: 'Northgate Bank', type: 'org', role: 'acquirer' },
    { name: 'Meridian Bank', type: 'org', role: 'failed bank' },
    { name: 'FDIC', type: 'org', role: 'seller' },
  ],
  claims: [
    'Northgate Bank agreed to assume all deposits of Meridian Bank.',
    'Northgate Bank agreed to buy the 40 branches of Meridian Bank from the FDIC.',
    'Meridian Bank branches will reopen under the Northgate Bank name on 2026-09-15.',
  ],
  speculation: [],
};

export const noLinks = { continues: null, storyline_title: null, links: [] };

const article = (title: string, body: string, publishedAt: string, source = 'Wire One'): DocumentIn => ({
  title, body, publishedAt, source, url: `https://wire.one/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
});

export const rateArticle = article(
  'Federal Reserve raises rates by half a point',
  'The Federal Reserve raised its benchmark interest rate by half a percentage point on Wednesday to a range of 5.5 to 5.75 percent, its largest increase this year. Chair Elena Ruiz said inflation remained too high.',
  '2026-08-01T18:00:00Z',
);
export const rateExtraction = {
  title: 'Federal Reserve raises benchmark rate by half a point',
  event_type: 'rate_decision',
  pattern: 'central bank raises benchmark interest rate by a large step citing inflation',
  occurred_at: '2026-08-01',
  entities: [
    { name: 'Federal Reserve', type: 'org', role: 'decision maker' },
    { name: 'Elena Ruiz', type: 'person', role: 'chair' },
  ],
  claims: [
    'The Federal Reserve raised its benchmark rate by half a percentage point on 2026-08-01.',
    'The Federal Reserve benchmark rate range is now 5.5 to 5.75 percent.',
    'Elena Ruiz said inflation remained too high.',
  ],
  speculation: [],
};

export const mortgageArticle = article(
  'Mortgage applications fall 12 percent after rate rise',
  'Applications for home loans fell 12 percent in the week to August 15, the Mortgage Lenders Council said, as the average 30-year rate climbed to 7.4 percent following the Federal Reserve increase earlier this month.',
  '2026-08-20T13:00:00Z',
);
export const mortgageExtraction = {
  title: 'Mortgage applications fall 12 percent as rates climb',
  event_type: 'economic_data',
  pattern: 'loan applications drop sharply after borrowing costs rise',
  occurred_at: '2026-08-15',
  entities: [{ name: 'Mortgage Lenders Council', type: 'org', role: 'data source' }],
  claims: [
    'Mortgage applications fell 12 percent in the week to 2026-08-15, the Mortgage Lenders Council said.',
    'The average 30-year mortgage rate climbed to 7.4 percent.',
  ],
  speculation: [],
};

export const quakeArticle1 = article(
  'Magnitude 6.1 earthquake strikes off coast of Chile',
  'A magnitude 6.1 earthquake struck off the coast of northern Chile on Sunday, the national seismology centre said. No damage or injuries were reported.',
  '2026-07-05T09:00:00Z',
);
export const quakeExtraction1 = {
  title: 'Magnitude 6.1 earthquake strikes off northern Chile',
  event_type: 'earthquake',
  pattern: 'moderate offshore earthquake with no reported damage',
  occurred_at: '2026-07-05',
  entities: [{ name: 'Chile', type: 'place', role: 'location' }],
  claims: ['A magnitude 6.1 earthquake struck off the coast of northern Chile on 2026-07-05.', 'No damage or injuries were reported in Chile after the earthquake.'],
  speculation: [],
};

export const quakeArticle2 = article(
  'Earthquake of magnitude 5.8 shakes central Japan',
  'A magnitude 5.8 earthquake shook central Japan early on Friday, the meteorological agency said. Trains were briefly halted and there were no reports of injuries.',
  '2026-07-24T02:00:00Z',
);
export const quakeExtraction2 = {
  title: 'Magnitude 5.8 earthquake shakes central Japan',
  event_type: 'earthquake',
  pattern: 'moderate inland earthquake briefly disrupts transport with no injuries',
  occurred_at: '2026-07-24',
  entities: [{ name: 'Japan', type: 'place', role: 'location' }],
  claims: ['A magnitude 5.8 earthquake shook central Japan on 2026-07-24.', 'Trains in central Japan were briefly halted after the earthquake.'],
  speculation: [],
};

export const hearingArticle = article(
  'Senate panel grills regulators over Meridian collapse',
  'The Senate Banking Committee questioned Ohio and federal regulators on Tuesday about why Meridian Bank was allowed to build up large unhedged bond holdings. Committee chair Marcus Hale called the supervision a failure.',
  '2026-10-06T20:00:00Z',
);
export const hearingExtraction = {
  title: 'Senate Banking Committee holds hearing on Meridian Bank failure',
  event_type: 'legislative_hearing',
  pattern: 'legislators question regulators about supervision before a bank failure',
  occurred_at: '2026-10-06',
  entities: [
    { name: 'Senate Banking Committee', type: 'org', role: 'convener' },
    { name: 'Meridian Bank', type: 'org', role: 'subject' },
    { name: 'Marcus Hale', type: 'person', role: 'committee chair' },
  ],
  claims: [
    'The Senate Banking Committee questioned Ohio and federal regulators about Meridian Bank on 2026-10-06.',
    'Marcus Hale called the supervision of Meridian Bank a failure.',
  ],
  speculation: [],
};

export const harborArticle = article(
  'Harbor Trust Bank fails after depositors flee',
  'Harbor Trust Bank of Nevada was closed by regulators on Friday after depositors withdrew 900 million dollars in a week, following losses on its bond portfolio. The FDIC was appointed receiver.',
  '2026-06-13T22:00:00Z',
);
export const harborExtraction = {
  title: 'Harbor Trust Bank closed by regulators after deposit flight',
  event_type: 'bank_failure',
  pattern: 'regional bank collapses after deposit run caused by bond losses',
  occurred_at: '2026-06-12',
  entities: [
    { name: 'Harbor Trust Bank', type: 'org', role: 'failed bank' },
    { name: 'FDIC', type: 'org', role: 'receiver' },
  ],
  claims: [
    'Harbor Trust Bank was closed by regulators on 2026-06-12.',
    'Depositors withdrew 900 million dollars from Harbor Trust Bank in a week.',
  ],
  speculation: [],
};

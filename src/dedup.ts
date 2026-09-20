import { createHash } from 'node:crypto';

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sha256(text: string): Buffer {
  return createHash('sha256').update(text).digest();
}

const hash64 = (text: string): bigint => createHash('sha256').update(text).digest().readBigUInt64BE(0);

// Word-frequency SimHash over already-normalized text.
export function simhash(text: string): bigint {
  const counts = new Map<string, number>();
  for (const word of text.split(' ')) if (word) counts.set(word, (counts.get(word) ?? 0) + 1);
  const sums = new Array<number>(64).fill(0);
  for (const [word, count] of counts) {
    const h = hash64(word);
    for (let bit = 0; bit < 64; bit++) sums[bit]! += (h >> BigInt(bit)) & 1n ? count : -count;
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit++) if (sums[bit]! > 0) out |= 1n << BigInt(bit);
  return out;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

// Postgres bigint is signed; the hash is an unsigned 64-bit value.
export const toSigned64 = (x: bigint): string => (x > 0x7fffffffffffffffn ? x - (1n << 64n) : x).toString();
export const fromSigned64 = (s: string): bigint => {
  const x = BigInt(s);
  return x < 0n ? x + (1n << 64n) : x;
};

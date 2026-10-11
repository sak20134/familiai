// Password hashing, tokens and ids. Uses only Node's built-in crypto.

import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const KEY_LEN = 64;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Format: scrypt$<salt base64>$<hash base64> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, PARAMS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, PARAMS);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const newToken = (): string => randomBytes(32).toString('base64url');
export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
export const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L to avoid mix-ups
export function newInviteCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/**
 * Small in-memory limiter, e.g. to slow down password or invite-code guessing.
 * `blocked` only checks; `hit` records one attempt (call it for failures only where that makes sense).
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number, private readonly maxKeys = 10_000) {}

  private recent(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.max;
  }

  hit(key: string, now = Date.now()): void {
    if (this.hits.size >= this.maxKeys) this.evict(now);
    const r = this.recent(key, now);
    r.push(now);
    this.hits.set(key, r);
  }

  /** Check and record in one step. */
  allow(key: string, now = Date.now()): boolean {
    if (this.blocked(key, now)) return false;
    this.hit(key, now);
    return true;
  }

  private evict(now: number): void {
    for (const [k, v] of this.hits) {
      if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    // Still full (a flood of fresh keys): drop the oldest half rather than grow without limit.
    if (this.hits.size >= this.maxKeys) {
      const drop = [...this.hits.keys()].slice(0, Math.ceil(this.hits.size / 2));
      for (const k of drop) this.hits.delete(k);
    }
  }
}

/** All request limits, created per app so tests can use their own. */
export interface Limits {
  loginFailures: RateLimiter; // per network address + email
  loginFailuresPerIp: RateLimiter; // per network address, any email
  signups: RateLimiter; // per network address
  inviteGuesses: RateLimiter; // wrong invite codes per network address
}

export function defaultLimits(): Limits {
  return {
    loginFailures: new RateLimiter(10, 15 * 60_000),
    loginFailuresPerIp: new RateLimiter(50, 15 * 60_000),
    signups: new RateLimiter(10, 60 * 60_000),
    inviteGuesses: new RateLimiter(10, 15 * 60_000),
  };
}

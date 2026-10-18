// Two small HTTP listeners inside the bot:
//   control - 127.0.0.1 only, for the `familyai` terminal command. A random key in the app's
//             data folder proves the caller is someone logged in on this computer.
//   phone   - the home Wi-Fi, ONLY when "Phone control" is switched on. A phone must pair once
//             with the 6-digit code shown on the PC; after that it sends its own key.
// Every request still goes through the bot's gate with that person's family role, so a child's
// phone can ask, but cannot approve, change limits or turn on take-over.

import { can } from '@familiai/core';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import type { Actor, Outcome, Reply } from '../agent/types';
import type { Family } from '../family/family';

export interface BotFacade {
  family: Family;
  handle(text: string, actor: Actor): Promise<Reply>;
  approve(id: string, actor: Actor): Promise<Outcome>;
  reject(id: string, actor: Actor): Outcome;
  stop(actor: Actor): void;
  state(actor: Actor): Record<string, unknown>;
  quit(): void;
}

type Kind = 'control' | 'phone';

const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const WINDOW_MS = 60_000;

class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly now: () => number) {}
  allow(key: string): boolean {
    const t = this.now();
    const list = (this.hits.get(key) ?? []).filter((x) => t - x < WINDOW_MS);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return false;
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 1000) this.hits.clear(); // a flood of addresses must not eat memory
    return true;
  }
}

export interface RemoteOptions {
  bot: BotFacade;
  controlToken: string;
  phonePage: () => string;
  now?: () => number;
}

export class RemoteServer {
  private control: Server | null = null;
  private phone: Server | null = null;
  private readonly now: () => number;
  private readonly general: RateLimiter;
  private readonly pairing: RateLimiter;

  constructor(private readonly o: RemoteOptions) {
    this.now = o.now ?? Date.now;
    this.general = new RateLimiter(120, this.now);
    this.pairing = new RateLimiter(5, this.now);
  }

  async startControl(port: number): Promise<number> {
    this.control = await listen(createServer((q, s) => void this.route('control', q, s)), port, '127.0.0.1');
    return (this.control.address() as AddressInfo).port;
  }

  async startPhone(port: number): Promise<number> {
    await this.stopPhone();
    this.phone = await listen(createServer((q, s) => void this.route('phone', q, s)), port, '0.0.0.0');
    return (this.phone.address() as AddressInfo).port;
  }

  async stopPhone(): Promise<void> {
    const s = this.phone;
    this.phone = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  phoneRunning(): boolean {
    return this.phone !== null;
  }

  async close(): Promise<void> {
    await this.stopPhone();
    const c = this.control;
    this.control = null;
    if (c) await new Promise<void>((r) => c.close(() => r()));
  }

  private async route(kind: Kind, req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const ip = req.socket.remoteAddress ?? '?';
    try {
      if (!this.general.allow(`${kind}:${ip}`)) return send(res, 429, { error: 'Too many requests. Wait a minute.' });
      const url = new URL(req.url ?? '/', 'http://x');

      // The control port refuses other host names, so a web page cannot reach it by DNS tricks.
      if (kind === 'control' && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) return send(res, 403, { error: 'Local only.' });

      if (kind === 'phone' && req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(this.o.phonePage());
        return;
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });

      if (req.method === 'POST' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'Send JSON.' });
      const body = req.method === 'POST' ? await readJson(req) : {};

      if (kind === 'phone' && url.pathname === '/api/pair' && req.method === 'POST') {
        if (!this.pairing.allow(ip)) return send(res, 429, { error: 'Too many tries. Wait a minute.' });
        const { token, member } = this.o.bot.family.completePairing(String(body.code ?? ''), String(body.name ?? 'Phone'));
        return send(res, 200, { token, member: { name: member.name, role: member.role } });
      }

      const actor = this.authenticate(kind, req);
      if (!actor) return send(res, 401, { error: 'This device is not paired. Pair it with the code on the computer.' });

      switch (`${req.method} ${url.pathname}`) {
        case 'GET /api/state':
          return send(res, 200, this.o.bot.state(actor));
        case 'POST /api/command': {
          const text = typeof body.text === 'string' ? body.text : '';
          return send(res, 200, await this.o.bot.handle(text, actor));
        }
        case 'POST /api/approve':
          return send(res, 200, await this.o.bot.approve(String(body.id ?? ''), actor));
        case 'POST /api/reject':
          return send(res, 200, this.o.bot.reject(String(body.id ?? ''), actor));
        case 'POST /api/stop':
          this.o.bot.stop(actor);
          return send(res, 200, { ok: true });
        case 'POST /api/quit':
          if (kind !== 'control') return send(res, 403, { error: 'Only the computer can quit the bot.' });
          send(res, 200, { ok: true });
          setTimeout(() => this.o.bot.quit(), 100);
          return;
        default:
          return send(res, 404, { error: 'Not found.' });
      }
    } catch (err) {
      return send(res, err instanceof HttpError ? err.status : 400, { error: err instanceof Error ? err.message : 'Bad request.' });
    }
  }

  private authenticate(kind: Kind, req: IncomingMessage): Actor | null {
    const auth = String(req.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return null;
    const fam = this.o.bot.family;
    if (kind === 'control') {
      const a = Buffer.from(token);
      const b = Buffer.from(this.o.controlToken);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      return fam.actor(fam.owner(), 'cli');
    }
    const found = fam.authenticate(token);
    return found ? fam.actor(found.member, 'phone') : null;
  }
}

/** What a member may see in the state answer. Activity is for adults; children see their own. */
export function visibleActivity<T extends { actor: string }>(actor: Actor, entries: readonly T[]): T[] {
  if (can({ id: actor.id, familyId: 'local', role: actor.role }, 'view_activity')) return [...entries];
  return entries.filter((e) => e.actor === actor.name);
}

function listen(server: Server, port: number, host: string): Promise<Server> {
  server.requestTimeout = 120_000;
  server.headersTimeout = 10_000;
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use. Pick another one in Settings.`) : err));
    server.listen(port, host, () => resolve(server));
  });
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Keep reading (and throwing away) the rest, so the sender still gets a clear answer.
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'That request is too big.'));
        return;
      }
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      } catch {
        reject(new Error('That was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

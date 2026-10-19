// Read-only Gmail. The person signs in with Google once (in their own browser; the bot never sees
// their password) and allows ONE permission: "read your email". The bot cannot send, delete or
// change anything, because it never asks for that permission. The long-lived token is kept
// encrypted by the operating system, like every other key.
//
// Needs the person's own Google "desktop app" client ID and secret (Settings explains how).

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export interface GmailOptions {
  clientId: () => string;
  clientSecret: () => string;
  refreshToken: () => string | undefined;
  saveRefreshToken: (token: string) => void;
  openExternal: (url: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface MailSummary {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
  /** "5m ago", "2h ago", "3d ago" */
  when: string;
}

// Tidy-ups borrowed from the Vantage deck: show a name instead of an address, plain text instead of
// HTML entities, and a friendly age.
export const cleanSender = (s: string): string => s.replace(/<[^>]+>/, '').replace(/"/g, '').trim() || /<([^>]+)>/.exec(s)?.[1] || s || 'unknown';
export const decodeEntities = (s: string): string => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
export function ago(ms: number, now: number): string {
  if (!ms || Number.isNaN(ms)) return '';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const b64url = (b: Buffer) => b.toString('base64url');

export class Gmail {
  private access: { token: string; expires: number } | null = null;
  constructor(private readonly o: GmailOptions) {}

  get connected(): boolean {
    return Boolean(this.o.refreshToken());
  }

  private f(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }

  /** Opens Google's sign-in in the browser and waits for the person to allow read-only access. */
  async connect(): Promise<void> {
    const clientId = this.o.clientId();
    const clientSecret = this.o.clientSecret();
    if (!clientId || !clientSecret) throw new Error('Paste your Google client ID and client secret in Settings first.');
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const code = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Sign-in took too long. Press Connect Gmail and try again.')), 3 * 60_000);
        timer.unref?.();
        server.on('request', (req, res) => {
          const u = new URL(req.url ?? '/', redirect);
          const err = u.searchParams.get('error');
          const got = u.searchParams.get('code');
          res.setHeader('content-type', 'text/html; charset=utf-8');
          if (u.searchParams.get('state') !== state || (!got && !err)) {
            res.statusCode = 400;
            res.end('Not the sign-in answer I was waiting for.');
            return;
          }
          res.end(`<p style="font-family:sans-serif">${err ? 'Sign-in was cancelled.' : 'Gmail is connected. You can close this tab.'}</p>`);
          clearTimeout(timer);
          if (err || !got) reject(new Error('Gmail sign-in was cancelled.'));
          else resolve(got);
        });
        const params = new URLSearchParams({
          client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: GMAIL_SCOPE, state,
          code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
          access_type: 'offline', prompt: 'consent',
        });
        this.o.openExternal(`${AUTH_URL}?${params}`).catch(reject);
      });
      const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirect });
      const res = await this.f()(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      const j = (await res.json().catch(() => ({}))) as { refresh_token?: string; access_token?: string; expires_in?: number };
      if (!res.ok || !j.refresh_token) throw new Error('Google did not accept the sign-in. Check the client ID and secret.');
      this.o.saveRefreshToken(j.refresh_token);
      if (j.access_token) this.access = { token: j.access_token, expires: (this.o.now ?? Date.now)() + (j.expires_in ?? 3000) * 1000 };
    } finally {
      server.close();
    }
  }

  private async token(): Promise<string> {
    const now = (this.o.now ?? Date.now)();
    if (this.access && this.access.expires - 60_000 > now) return this.access.token;
    const refresh = this.o.refreshToken();
    if (!refresh) throw new Error('Gmail is not connected. Open Settings and press Connect Gmail.');
    const body = new URLSearchParams({ client_id: this.o.clientId(), client_secret: this.o.clientSecret(), refresh_token: refresh, grant_type: 'refresh_token' });
    const res = await this.f()(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !j.access_token) throw new Error('Gmail sign-in expired. Press Connect Gmail in Settings again.');
    this.access = { token: j.access_token, expires: now + (j.expires_in ?? 3000) * 1000 };
    return this.access.token;
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.f()(`${API}${path}`, { headers: { authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      if (err instanceof Error && /Gmail/.test(err.message)) throw err;
      throw new Error('I could not reach Gmail. Check your internet connection.');
    }
    if (res.status === 401 || res.status === 403) throw new Error('Gmail did not allow that. Press Connect Gmail in Settings again.');
    if (!res.ok) throw new Error(`Gmail answered with an error (${res.status}).`);
    return (await res.json()) as T;
  }

  /** Recent messages (unread by default), newest first. */
  async check(query = 'is:unread in:inbox', max = 5): Promise<MailSummary[]> {
    const q = encodeURIComponent(query.trim().slice(0, 200) || 'in:inbox');
    const list = await this.get<{ messages?: Array<{ id: string }> }>(`/messages?q=${q}&maxResults=${Math.min(10, Math.max(1, max))}`);
    const out: MailSummary[] = [];
    for (const m of list.messages ?? []) {
      const msg = await this.get<{ id: string; snippet?: string; internalDate?: string; labelIds?: string[]; payload?: { headers?: Array<{ name: string; value: string }> } }>(`/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      const h = (n: string) => msg.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? '';
      out.push({ id: msg.id, from: cleanSender(h('from')), subject: decodeEntities(h('subject') || '(no subject)'), date: h('date'), snippet: decodeEntities(msg.snippet ?? ''), unread: (msg.labelIds ?? []).includes('UNREAD'), when: ago(Number(msg.internalDate) || Date.parse(h('date')), (this.o.now ?? Date.now)()) });
    }
    return out;
  }

  /** The plain text of one message, cut to a sensible length. */
  async read(id: string): Promise<{ from: string; subject: string; date: string; text: string }> {
    type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[] };
    const msg = await this.get<{ snippet?: string; payload?: Part & { headers?: Array<{ name: string; value: string }> } }>(`/messages/${encodeURIComponent(id)}?format=full`);
    const h = (n: string) => msg.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? '';
    const find = (p: Part | undefined, type: string): string | null => {
      if (!p) return null;
      if (p.mimeType === type && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
      for (const c of p.parts ?? []) { const r = find(c, type); if (r) return r; }
      return null;
    };
    let text = find(msg.payload, 'text/plain');
    if (!text) text = (find(msg.payload, 'text/html') ?? msg.snippet ?? '').replace(/<[^>]+>/g, ' ');
    return { from: h('from'), subject: h('subject') || '(no subject)', date: h('date'), text: text.replace(/\s+/g, ' ').trim().slice(0, 3000) };
  }
}

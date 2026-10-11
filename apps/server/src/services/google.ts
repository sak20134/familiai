// Google sign-in for Calendar: per-user OAuth, encrypted tokens, automatic refresh, honest revoke.

import type { TokenProvider } from '@familiai/core';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '../db/client';
import { decrypt, encrypt, newId, newToken } from '../security';
import type { GoogleConfig, Services } from './types';

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_TTL_MS = 10 * 60_000;

/** One-time "state" values tie the Google redirect back to the user who started it (stops login CSRF). */
const pendingStates = new Map<string, { userId: string; expires: number }>();

export function startGoogleAuth(cfg: GoogleConfig, userId: string, now = Date.now()): string {
  for (const [k, v] of pendingStates) if (v.expires < now) pendingStates.delete(k);
  const state = newToken();
  pendingStates.set(state, { userId, expires: now + STATE_TTL_MS });
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Returns true only if `state` was issued to this same user and not used before. */
export function consumeState(state: string, userId: string, now = Date.now()): boolean {
  const s = pendingStates.get(state);
  pendingStates.delete(state);
  return Boolean(s && s.userId === userId && s.expires >= now);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

async function tokenRequest(fetchImpl: typeof fetch, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Google refused the request (${res.status}).`);
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token) throw new Error('Google did not return an access token.');
  return json;
}

/** The email inside Google's id_token (it came straight from Google over TLS; used only as a label). */
function emailFromIdToken(idToken?: string): string {
  try {
    const payload = JSON.parse(Buffer.from(idToken!.split('.')[1]!, 'base64url').toString('utf8')) as { email?: string };
    return payload.email ?? 'Google account';
  } catch {
    return 'Google account';
  }
}

export async function finishGoogleAuth(db: Db, services: Services, userId: string, code: string): Promise<string> {
  const cfg = services.google!;
  const t = await tokenRequest(services.fetchImpl ?? fetch, {
    code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code',
  });
  const scopes = (t.scope ?? '').split(' ').filter(Boolean);
  const label = emailFromIdToken(t.id_token);
  // One Google connection per user: replace any older one.
  await db.delete(schema.connections).where(and(eq(schema.connections.userId, userId), eq(schema.connections.provider, 'google')));
  const id = newId('con');
  await db.insert(schema.connections).values({ id, userId, provider: 'google', accountLabel: label, scopes, status: 'connected' });
  await db.insert(schema.oauthTokens).values({
    connectionId: id,
    accessTokenEnc: encrypt(t.access_token!, services.secretKey),
    refreshTokenEnc: t.refresh_token ? encrypt(t.refresh_token, services.secretKey) : null,
    expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000),
  });
  return label;
}

async function liveGoogle(db: Db, userId: string) {
  const [row] = await db
    .select({ conn: schema.connections, tok: schema.oauthTokens })
    .from(schema.connections)
    .innerJoin(schema.oauthTokens, eq(schema.oauthTokens.connectionId, schema.connections.id))
    .where(and(eq(schema.connections.userId, userId), eq(schema.connections.provider, 'google'), eq(schema.connections.status, 'connected')));
  return row;
}

/** Gives a valid access token, refreshing it when it is about to expire. */
export function googleTokens(db: Db, services: Services): TokenProvider {
  return {
    async getAccessToken(userId) {
      const row = await liveGoogle(db, userId);
      if (!row) throw new Error('Google Calendar is not connected. Connect it in Settings first.');
      if (row.tok.expiresAt.getTime() - Date.now() > 60_000) return decrypt(row.tok.accessTokenEnc, services.secretKey);
      if (!row.tok.refreshTokenEnc || !services.google) throw new Error('Google sign-in expired. Reconnect it in Settings.');
      try {
        const cfg = services.google;
        const t = await tokenRequest(services.fetchImpl ?? fetch, {
          refresh_token: decrypt(row.tok.refreshTokenEnc, services.secretKey),
          client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token',
        });
        await db.update(schema.oauthTokens).set({
          accessTokenEnc: encrypt(t.access_token!, services.secretKey),
          expiresAt: new Date(Date.now() + (t.expires_in ?? 3600) * 1000),
        }).where(eq(schema.oauthTokens.connectionId, row.conn.id));
        return t.access_token!;
      } catch (err) {
        await db.update(schema.connections).set({ status: 'needs_reauth', lastError: err instanceof Error ? err.message : 'refresh failed' })
          .where(eq(schema.connections.id, row.conn.id));
        throw new Error('Google sign-in expired. Reconnect it in Settings.');
      }
    },
  };
}

/** Revoke at Google FIRST; only then mark revoked and delete our tokens. */
export async function revokeConnection(db: Db, services: Services, userId: string, connectionId: string): Promise<void> {
  const [conn] = await db.select().from(schema.connections)
    .where(and(eq(schema.connections.id, connectionId), eq(schema.connections.userId, userId)));
  if (!conn) throw new Error('No such connection.');
  const [tok] = await db.select().from(schema.oauthTokens).where(eq(schema.oauthTokens.connectionId, conn.id));
  if (tok && conn.provider === 'google') {
    const token = decrypt(tok.refreshTokenEnc ?? tok.accessTokenEnc, services.secretKey);
    // Token goes in the body, not the URL, so it never lands in proxy or server logs.
    const res = await (services.fetchImpl ?? fetch)('https://oauth2.googleapis.com/revoke', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }), signal: AbortSignal.timeout(15_000),
    });
    // 400 "invalid_token" means Google already forgot it: that is fine to treat as revoked.
    if (!res.ok && res.status !== 400) throw new Error(`Google could not revoke access (${res.status}). Try again.`);
  }
  await db.delete(schema.oauthTokens).where(eq(schema.oauthTokens.connectionId, conn.id));
  await db.update(schema.connections).set({ status: 'revoked', scopes: [] }).where(eq(schema.connections.id, conn.id));
}

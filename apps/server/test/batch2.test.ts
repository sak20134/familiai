// AI Mode, aliases, house, hub, check-ins, calls, and Google Calendar (all external services faked).

import type { CallProvider } from '@familiai/core';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { planDemo } from '../src/brain/demo';
import { createDb, schema, type Db } from '../src/db/client';
import { decrypt, encrypt, RateLimiter, type Limits } from '../src/security';
import { runCheckIns } from '../src/services/checkins';
import type { Services } from '../src/services/types';

let db: Db;
let close: () => Promise<void>;
const calls: Array<{ to: string; say?: string }> = [];
const fakeCalls: CallProvider = { startCall: async (r) => { calls.push(r); return { callId: `CA${calls.length}` }; } };
const googleLog: string[] = [];
const fakeGoogle = (async (url: string, init?: RequestInit) => {
  googleLog.push(`${init?.method ?? 'GET'} ${url}`);
  if (url.includes('oauth2.googleapis.com/token')) {
    const idPayload = Buffer.from(JSON.stringify({ email: 'mom@gmail.com' })).toString('base64url');
    return Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/calendar.events', id_token: `x.${idPayload}.y` });
  }
  if (url.includes('/revoke')) return new Response('', { status: 200 });
  if (url.includes('/calendars/primary/events/ev9')) return Response.json({ id: 'ev9' });
  if (url.includes('/calendars/primary/events') && init?.method === 'POST') return Response.json({ id: 'ev9' });
  if (url.includes('/calendars/primary/events')) return Response.json({ items: [{ id: 'e1', summary: 'Dentist', start: { dateTime: '2026-10-12T10:00:00+05:30' } }] });
  return new Response('?', { status: 404 });
}) as unknown as typeof fetch;

const services: Services = {
  secretKey: randomBytes(32),
  calls: { provider: fakeCalls, from: '+15550001111' },
  google: { clientId: 'cid', clientSecret: 'secret', redirectUri: 'http://localhost/api/oauth/google/callback' },
  fetchImpl: fakeGoogle,
};
const roomy = (): Limits => ({ loginFailures: new RateLimiter(999, 1), loginFailuresPerIp: new RateLimiter(999, 1), signups: new RateLimiter(999, 1), inviteGuesses: new RateLimiter(999, 1) });
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  ({ db, close } = await createDb());
  app = createApp(db, { model: 't' }, roomy(), services);
});
afterAll(async () => close());

class Client {
  cookie = '';
  async req(method: string, path: string, json?: unknown) {
    const res = await app.request(path, { method, redirect: 'manual', headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) }, ...(json !== undefined ? { body: JSON.stringify(json) } : {}) });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, data, location: res.headers.get('location') };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, j: unknown = {}) => this.req('POST', p, j);
}
let n = 0;
async function user(name: string) {
  const c = new Client();
  await c.post('/api/auth/signup', { email: `${name}${++n}@b2.test`, password: 'longenough1', displayName: name });
  return c;
}
async function join(owner: Client, role: string, name: string) {
  const inv = await owner.post('/api/family/invites', { role });
  const c = await user(name);
  await c.post('/api/invites/accept', { code: inv.data.code });
  return c;
}

describe('AI Mode and names', () => {
  it('skips approval for medium risk but never for money; kids cannot turn it on', async () => {
    const owner = await user('Appa');
    await owner.post('/api/family', { name: 'Auto' });
    expect((await owner.req('PATCH', '/api/me', { aiMode: true })).data.aiMode).toBe(true);
    const r1 = await owner.post('/api/chat', { message: 'spent 300 on milk' });
    expect(r1.data.outcomes[0].kind).toBe('done');
    const r2 = await owner.post('/api/chat', { message: 'pay 100 to Ravi' });
    expect(r2.data.outcomes[0].kind).toBe('needs_approval');
    const kid = await join(owner, 'child', 'Kutty');
    expect((await kid.req('PATCH', '/api/me', { aiMode: true })).status).toBe(403);
  });
  it('saves aliases as extra wake phrases and validates phone numbers', async () => {
    const c = await user('Alias');
    await c.post('/api/family', { name: 'A' });
    const r = await c.req('PATCH', '/api/me', { aiName: 'Nova', aliases: ['Buddy', 'Jarvis'], phone: '+919800000001' });
    expect(r.data.wakePhrases).toEqual(['hey nova', 'hey buddy', 'hey jarvis']);
    expect(r.data.member.phone).toBe('+919800000001');
    expect((await c.req('PATCH', '/api/me', { phone: '98000' })).status).toBe(400);
  });
});

describe('house and hub', () => {
  it('saves house items from chat and shows them in the hub', async () => {
    const c = await user('House');
    await c.post('/api/family', { name: 'H' });
    const r = await c.post('/api/chat', { message: 'add appliance Fridge (Samsung, bought 2022)' });
    expect(r.data.outcomes[0].kind).toBe('done');
    expect((await c.get('/api/records/house')).data[0]).toMatchObject({ kind: 'appliance', name: 'Fridge' });
    const hub = await c.get('/api/records/hub');
    expect(hub.data).toMatchObject({ houseItems: 1, members: 1, moneyThisMonth: 0 });
    expect(planDemo("what's in the house")?.tool).toBe('list_house');
  });
  it('hides family money from children in the hub', async () => {
    const owner = await user('HubOwner');
    await owner.post('/api/family', { name: 'H2' });
    const kid = await join(owner, 'child', 'HubKid');
    expect((await kid.get('/api/records/hub')).data.moneyThisMonth).toBeNull();
  });
});

describe('calls', () => {
  it('places a real call through the provider after approval', async () => {
    const owner = await user('Caller');
    await owner.post('/api/family', { name: 'C' });
    const dad = await join(owner, 'adult', 'Ravi');
    await dad.req('PATCH', '/api/me', { nickname: 'Dad', phone: '+919811111111' });
    await owner.post('/api/chat', { message: 'call Dad' });
    const p = await owner.get('/api/approvals');
    const res = await owner.post(`/api/approvals/${p.data[0].id}/approve`);
    expect(res.data.status).toBe('verified');
    expect(calls.at(-1)).toMatchObject({ to: '+919811111111' });
  });
});

describe('check-ins and emergency', () => {
  it('escalates once per missed check-in: remind, then alert admins, then emergency', async () => {
    const owner = await user('Admin');
    await owner.post('/api/family', { name: 'Care' });
    await owner.req('PATCH', '/api/me', { phone: '+919822222222' });
    const elder = await join(owner, 'elder', 'Paati');
    await elder.req('PATCH', '/api/me', { phone: '+919833333333' });
    const fam = await owner.get('/api/family');
    const elderId = fam.data.members.find((m: any) => m.role === 'elder').id;
    expect((await owner.req('PUT', `/api/checkins/${elderId}`, { hour: 9, minute: 0, utcOffsetMinutes: 330, graceMinutes: 30 })).status).toBe(200);
    expect((await elder.req('PUT', `/api/checkins/${elderId}`, { hour: 9, minute: 0, utcOffsetMinutes: 330 })).status).toBe(403);

    const day = (d: number) => Date.UTC(2026, 9, d, 5, 0); // 10:30 IST, after the 09:00 check-in + grace
    const mine = (evs: Awaited<ReturnType<typeof runCheckIns>>) => evs.filter((e) => e.memberId === elderId);
    expect(mine(await runCheckIns(db, services, day(12)))[0]).toMatchObject({ action: 'retry_call', ok: true });
    expect(mine(await runCheckIns(db, services, day(12)))).toHaveLength(0); // handled once
    expect(mine(await runCheckIns(db, services, day(13)))[0]).toMatchObject({ action: 'notify_admins' });
    expect(mine(await runCheckIns(db, services, day(14)))[0]).toMatchObject({ action: 'call_emergency_contact', ok: true });
    expect(calls.some((c) => c.to === '+919822222222' && c.say?.includes('Emergency'))).toBe(true);

    expect((await elder.post('/api/checkins/answer')).status).toBe(200);
    const [plan] = await db.select().from(schema.checkInPlans).where(eq(schema.checkInPlans.memberId, elderId));
    expect(plan!.missCount).toBe(0);
  });
});

describe('google calendar', () => {
  it('connects with a one-time state, stores tokens encrypted, uses them, and revokes first', async () => {
    const c = await user('Gmail');
    await c.post('/api/family', { name: 'G' });
    const start = await c.post('/api/connections/google/start');
    const state = new URL(start.data.url).searchParams.get('state')!;
    expect(start.data.url).toContain('client_id=cid');
    // A different user cannot use this state.
    const other = await user('Thief');
    expect((await other.get(`/api/oauth/google/callback?code=abc&state=${state}`)).location).toBe('/?connect=expired');
    // State was consumed by that attempt; start again for the real user.
    const start2 = await c.post('/api/connections/google/start');
    const state2 = new URL(start2.data.url).searchParams.get('state')!;
    expect((await c.get(`/api/oauth/google/callback?code=abc&state=${state2}`)).location).toBe('/?connect=google');
    const list = await c.get('/api/connections');
    expect(list.data.connections[0]).toMatchObject({ provider: 'google', accountLabel: 'mom@gmail.com', status: 'connected' });
    const [tok] = await db.select().from(schema.oauthTokens);
    expect(tok!.accessTokenEnc).not.toContain('at-1');
    expect(decrypt(tok!.accessTokenEnc, services.secretKey)).toBe('at-1');

    const r = await c.post('/api/chat', { message: "what's on my calendar" });
    expect(r.data.reply).toContain('Dentist');

    expect((await c.req('DELETE', `/api/connections/${list.data.connections[0].id}`, {})).status).toBe(200);
    expect(googleLog.some((l) => l.startsWith('POST https://oauth2.googleapis.com/revoke'))).toBe(true);
    expect((await c.get('/api/connections')).data.connections[0].status).toBe('revoked');
    expect((await c.post('/api/chat', { message: "what's on my calendar" })).data.reply).toMatch(/not connected/i);
  });
  it('encryption round-trips and rejects tampering', () => {
    const key = randomBytes(32);
    const sealed = encrypt('hello', key);
    expect(decrypt(sealed, key)).toBe('hello');
    const [iv, tag, data] = sealed.split('.');
    expect(() => decrypt(`${iv}.${tag}.${data!.slice(0, -2)}AA`, key)).toThrow();
  });
});

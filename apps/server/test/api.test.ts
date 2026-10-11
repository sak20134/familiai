import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createDb, type Db } from '../src/db/client';
import { planDemo } from '../src/brain/demo';
import { RateLimiter, defaultLimits, type Limits } from '../src/security';

/** Roomy limits so the suite can create many accounts from one address; real limits are tested below. */
const roomy = (): Limits => ({ loginFailures: new RateLimiter(1000, 60_000), loginFailuresPerIp: new RateLimiter(1000, 60_000), signups: new RateLimiter(1000, 60_000), inviteGuesses: new RateLimiter(1000, 60_000) });

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  ({ db, close } = await createDb());
  app = createApp(db, { model: 'test' }, roomy()); // no apiKey: demo brain
});
afterAll(async () => close());

/** A tiny browser: keeps its own session cookie. */
class Client {
  cookie = '';
  async req(method: string, path: string, json?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    const text = await res.text();
    let data: any = text;
    try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, data };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, j: unknown = {}) => this.req('POST', p, j);
}

let n = 0;
async function newUser(name: string) {
  const c = new Client();
  const r = await c.post('/api/auth/signup', { email: `${name.toLowerCase()}${++n}@example.com`, password: 'correct horse battery', displayName: name });
  expect(r.status).toBe(201);
  return c;
}

async function join(owner: Client, role: string, name: string) {
  const inv = await owner.post('/api/family/invites', { role });
  expect(inv.status).toBe(201);
  const c = await newUser(name);
  const r = await c.post('/api/invites/accept', { code: inv.data.code });
  expect(r.status).toBe(200);
  return c;
}

describe('auth', () => {
  it('signs up, logs out, logs back in, and rejects wrong passwords', async () => {
    const c = new Client();
    expect((await c.post('/api/auth/signup', { email: 'Asha@Example.com', password: 'longenough1', displayName: 'Asha' })).status).toBe(201);
    expect((await c.get('/api/me')).data.email).toBe('asha@example.com');
    await c.post('/api/auth/logout');
    expect((await c.get('/api/me')).status).toBe(401);
    expect((await c.post('/api/auth/login', { email: 'asha@example.com', password: 'wrong-password' })).status).toBe(401);
    expect((await c.post('/api/auth/login', { email: 'asha@example.com', password: 'longenough1' })).status).toBe(200);
    expect((await c.get('/api/me')).status).toBe(200);
  });
  it('rejects short passwords and duplicate emails', async () => {
    const c = new Client();
    expect((await c.post('/api/auth/signup', { email: 'x@example.com', password: 'short', displayName: 'X' })).status).toBe(400);
    await c.post('/api/auth/signup', { email: 'dup@example.com', password: 'longenough1', displayName: 'D' });
    expect((await new Client().post('/api/auth/signup', { email: 'dup@example.com', password: 'longenough1', displayName: 'D' })).status).toBe(409);
  });
  it('blocks non-JSON and cross-site writes', async () => {
    const c = await newUser('Csrf');
    expect((await c.req('POST', '/api/family', undefined, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await c.req('POST', '/api/family', { name: 'X' }, { origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('family server', () => {
  it('creates a family, invites by role, and enforces who can manage whom', async () => {
    const owner = await newUser('Owner');
    expect((await owner.post('/api/family', { name: 'Kumar' })).status).toBe(201);
    const admin = await join(owner, 'admin', 'Admin');
    const kid = await join(owner, 'child', 'Kid');
    const fam = await owner.get('/api/family');
    expect(fam.data.members).toHaveLength(3);
    const adminId = fam.data.members.find((m: any) => m.role === 'admin').id;
    const ownerId = fam.data.members.find((m: any) => m.role === 'owner').id;
    // Admin cannot invite another admin, cannot remove the owner, cannot remove another admin.
    expect((await admin.post('/api/family/invites', { role: 'admin' })).status).toBe(403);
    expect((await admin.req('DELETE', `/api/family/members/${ownerId}`, {})).status).toBe(403);
    // A child cannot invite anyone.
    expect((await kid.post('/api/family/invites', { role: 'adult' })).status).toBe(403);
    // Owner can demote the admin.
    expect((await owner.req('PATCH', `/api/family/members/${adminId}`, { role: 'adult' })).status).toBe(200);
  });
  it('an invite code works only once', async () => {
    const owner = await newUser('O2');
    await owner.post('/api/family', { name: 'F2' });
    const inv = await owner.post('/api/family/invites', { role: 'adult' });
    const a = await newUser('A');
    const b = await newUser('B');
    expect((await a.post('/api/invites/accept', { code: inv.data.code })).status).toBe(200);
    expect((await b.post('/api/invites/accept', { code: inv.data.code })).status).toBe(404);
  });
  it('admins of family A cannot touch family B', async () => {
    const ownerA = await newUser('OA');
    await ownerA.post('/api/family', { name: 'A' });
    const ownerB = await newUser('OB');
    await ownerB.post('/api/family', { name: 'B' });
    const kidB = await join(ownerB, 'adult', 'KidB');
    const famB = await ownerB.get('/api/family');
    const kidBId = famB.data.members.find((m: any) => m.role === 'adult').id;
    expect((await ownerA.req('DELETE', `/api/family/members/${kidBId}`, {})).status).toBe(404);
    await kidB.post('/api/chat', { message: 'remember for family the wifi password is in the drawer' });
    const aMem = await ownerA.get('/api/records/memories');
    expect(aMem.data.some((m: any) => m.text.includes('wifi'))).toBe(false);
  });
});

describe('brain, approvals and money', () => {
  it('logs an expense only after approval, and verifies it', async () => {
    const owner = await newUser('Mom');
    await owner.post('/api/family', { name: 'Money' });
    const r = await owner.post('/api/chat', { message: 'spent 600 on groceries' });
    expect(r.data.outcomes[0].kind).toBe('needs_approval');
    expect(r.data.reply).toMatch(/need your OK/);
    let sum = await owner.get('/api/records/money/summary');
    expect(sum.data.totalMinor).toBe(0); // nothing done before approval
    const pending = await owner.get('/api/approvals');
    expect(pending.data).toHaveLength(1);
    const ok = await owner.post(`/api/approvals/${pending.data[0].id}/approve`);
    expect(ok.data.status).toBe('verified');
    sum = await owner.get('/api/records/money/summary');
    expect(sum.data.totalMinor).toBe(60000);
    // Approving twice does nothing.
    expect((await owner.post(`/api/approvals/${pending.data[0].id}/approve`)).status).toBe(409);
  });
  it('a child cannot approve money; payments never pretend to succeed', async () => {
    const owner = await newUser('Dad');
    await owner.post('/api/family', { name: 'Pay' });
    const kid = await join(owner, 'child', 'Kiddo');
    const r = await kid.post('/api/chat', { message: 'pay 500 to Ravi' });
    expect(r.data.outcomes[0].kind).toBe('needs_approval');
    const kidView = await kid.get('/api/approvals');
    expect(kidView.data[0].canDecide).toBe(false);
    expect((await kid.post(`/api/approvals/${kidView.data[0].id}/approve`)).status).toBe(403);
    const ownerView = await owner.get('/api/approvals');
    const res = await owner.post(`/api/approvals/${ownerView.data[0].id}/approve`);
    expect(res.data.status).toBe('failed');
    expect(res.data.message).toMatch(/not connected/);
  });
  it('calls are high risk and fail honestly without a phone provider', async () => {
    const owner = await newUser('Caller');
    await owner.post('/api/family', { name: 'Calls' });
    await owner.req('PATCH', '/api/me', { nickname: 'Appa' });
    const r = await owner.post('/api/chat', { message: 'call Appa' });
    expect(r.data.outcomes[0].kind).toBe('needs_approval');
    const p = await owner.get('/api/approvals');
    const res = await owner.post(`/api/approvals/${p.data[0].id}/approve`);
    expect(res.data.status).toBe('failed');
  });
  it('rejecting does nothing', async () => {
    const owner = await newUser('Rej');
    await owner.post('/api/family', { name: 'R' });
    await owner.post('/api/chat', { message: 'remind me to buy milk' });
    const p = await owner.get('/api/approvals');
    expect((await owner.post(`/api/approvals/${p.data[0].id}/reject`)).data.status).toBe('rejected');
    expect((await owner.get('/api/records/reminders')).data).toHaveLength(0);
  });
});

describe('memory, vault and activity', () => {
  it('keeps private memory private even from admins, and logs vault views', async () => {
    const owner = await newUser('Own');
    await owner.post('/api/family', { name: 'Mem' });
    const teen = await join(owner, 'teen', 'Teen');
    await teen.post('/api/chat', { message: 'remember that my locker code is 4412' });
    expect((await owner.get('/api/records/memories')).data.some((m: any) => m.text.includes('locker'))).toBe(false);
    const mine = await teen.get('/api/records/memories');
    const id = mine.data.find((m: any) => m.text.includes('locker')).id;
    expect((await teen.req('DELETE', `/api/records/memories/${id}`, {})).status).toBe(200);
    expect((await teen.get('/api/records/vault')).status).toBe(403);
    const vault = await owner.get('/api/records/vault');
    // Regression: the admin must NOT be able to read a deleted private memory.
    expect(JSON.stringify(vault.data)).not.toContain('locker');
    expect(JSON.stringify(vault.data)).not.toContain('4412');
    const teenFeed = await teen.get('/api/records/activity');
    expect(teenFeed.data.some((a: any) => a.kind === 'vault_viewed')).toBe(true);
  });
  it('recall finds only what the asker may see', async () => {
    const owner = await newUser('Rec');
    await owner.post('/api/family', { name: 'Recall' });
    await owner.post('/api/chat', { message: 'remember for family the water filter was changed in March' });
    const r = await owner.post('/api/chat', { message: 'what do you remember about the water filter?' });
    expect(r.data.reply).toContain('March');
  });
});

describe('demo planner', () => {
  it('understands common phrasings', () => {
    expect(planDemo('I spent ₹1,250 on petrol today')).toEqual({ tool: 'add_expense', args: { amount: 1250, category: 'petrol today' } });
    expect(planDemo('remember for house the AC was serviced')?.args).toEqual({ text: 'the AC was serviced', scope: 'house' });
    expect(planDemo('how much did we spend this year?')?.args).toEqual({ period: 'year' });
    expect(planDemo('call Dad')?.tool).toBe('call_family_member');
    expect(planDemo('what is the weather')).toBeNull();
  });
});

describe('review fixes', () => {
  it('a child cannot self-approve, cannot log expenses, and cannot see family money', async () => {
    const owner = await newUser('Amma');
    await owner.post('/api/family', { name: 'Kids' });
    const kid = await join(owner, 'child', 'Chotu');
    const fake = await kid.post('/api/chat', { message: 'spent 500 on toys' });
    expect(fake.data.outcomes[0].kind).toBe('failed');
    expect((await kid.get('/api/records/money/summary')).status).toBe(403);
    await kid.post('/api/chat', { message: 'remind me to feed the cat' });
    const mine = await kid.get('/api/approvals');
    expect(mine.data[0].canDecide).toBe(false);
    expect((await kid.post(`/api/approvals/${mine.data[0].id}/approve`)).status).toBe(403);
    const ownerView = await owner.get('/api/approvals');
    expect((await owner.post(`/api/approvals/${ownerView.data[0].id}/approve`)).data.status).toBe('verified');
  });
  it('a member who logged expenses can still be removed, and the spending history stays', async () => {
    const owner = await newUser('Head');
    await owner.post('/api/family', { name: 'Leave' });
    const teen = await join(owner, 'teen', 'Teen2');
    await teen.post('/api/chat', { message: 'spent 250 on books' });
    const p = await owner.get('/api/approvals');
    expect((await owner.post(`/api/approvals/${p.data[0].id}/approve`)).data.status).toBe('verified');
    await owner.get('/api/records/vault'); // owner opens the vault too
    const fam = await owner.get('/api/family');
    const teenId = fam.data.members.find((m: any) => m.role === 'teen').id;
    expect((await owner.req('DELETE', `/api/family/members/${teenId}`, {})).status).toBe(200);
    expect((await owner.get('/api/records/money/summary')).data.totalMinor).toBe(25000);
    expect((await teen.get('/api/family')).status).toBe(409); // no longer in a family
  });
});

describe('rate limits (real settings)', () => {
  it('locks one address+email after 10 bad logins without locking other emails', async () => {
    const strict = createApp(db, { model: 'test' }, defaultLimits());
    const call = (path: string, json: unknown) => strict.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) });
    await call('/api/auth/signup', { email: 'victim@example.com', password: 'right-password-1', displayName: 'V' });
    await call('/api/auth/signup', { email: 'other@example.com', password: 'right-password-1', displayName: 'O' });
    for (let i = 0; i < 10; i++) expect((await call('/api/auth/login', { email: 'victim@example.com', password: 'nope-nope-nope' })).status).toBe(401);
    expect((await call('/api/auth/login', { email: 'victim@example.com', password: 'right-password-1' })).status).toBe(429);
    expect((await call('/api/auth/login', { email: 'other@example.com', password: 'right-password-1' })).status).toBe(200);
  });
  it('limits signups and invite-code guessing per address', async () => {
    const strict = createApp(db, { model: 'test' }, defaultLimits());
    const statuses: number[] = [];
    let cookie = '';
    for (let i = 0; i < 11; i++) {
      const r = await strict.request('/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `flood${i}@example.com`, password: 'longenough1', displayName: 'F' }) });
      statuses.push(r.status);
      if (i === 0) cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    const guess = () => strict.request('/api/invites/accept', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ code: 'ZZZZZZZZ' }) });
    for (let i = 0; i < 10; i++) expect((await guess()).status).toBe(404);
    expect((await guess()).status).toBe(429);
  });
});

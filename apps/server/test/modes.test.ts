// The five modes, the Family Twin and the memory timeline. The AI model is faked where needed.

import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { invokeTool } from '../src/brain/actions';
import { createDb, schema, type Db } from '../src/db/client';
import { RateLimiter, type Limits } from '../src/security';

let db: Db;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let modelApp: ReturnType<typeof createApp>;

/** Captures what would have been sent to the AI model, and replies with scripted text. */
const sent: Array<Record<string, any>> = [];
const fakeModel = (async (_url: string, init?: RequestInit) => {
  sent.push(JSON.parse(String(init?.body)));
  return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Okay.' }] });
}) as unknown as typeof fetch;

const roomy = (): Limits => ({
  loginFailures: new RateLimiter(999, 1), loginFailuresPerIp: new RateLimiter(999, 1),
  signups: new RateLimiter(999, 1), inviteGuesses: new RateLimiter(999, 1),
});

beforeAll(async () => {
  ({ db, close } = await createDb());
  const services = { secretKey: randomBytes(32) };
  app = createApp(db, { model: 't' }, roomy(), services);
  modelApp = createApp(db, { apiKey: 'k', model: 'm', fetchImpl: fakeModel }, roomy(), services);
});
afterAll(async () => close());

class Client {
  cookie = '';
  constructor(private readonly target: () => ReturnType<typeof createApp>) {}
  async req(method: string, path: string, json?: unknown) {
    const res = await this.target().request(path, {
      method,
      headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.cookie ? { cookie: this.cookie } : {}) },
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
  /** The same signed-in person, talking to the app that has an AI key. */
  withModel() {
    const c = new Client(() => modelApp);
    c.cookie = this.cookie;
    return c;
  }
}

let n = 0;
async function user(name: string) {
  const c = new Client(() => app);
  await c.post('/api/auth/signup', { email: `${name}${++n}@modes.test`, password: 'longenough1', displayName: name });
  return c;
}
async function join(owner: Client, role: string, name: string) {
  const inv = await owner.post('/api/family/invites', { role });
  const c = await user(name);
  await c.post('/api/invites/accept', { code: inv.data.code });
  return c;
}

describe('voice mode', () => {
  it('strips the wake phrase before the AI sees it, and keeps its own thread', async () => {
    const owner = await user('Asha');
    await owner.post('/api/family', { name: 'Voice' });
    await owner.req('PATCH', '/api/me', { aiName: 'Nova' });

    const r = await owner.post('/api/chat', { message: 'Hey Nova, remember that the gate code is 4321', mode: 'voice' });
    expect(r.status).toBe(200);
    expect(r.data.outcomes[0]).toMatchObject({ kind: 'done', tool: 'remember' });
    const saved = await db.select().from(schema.memories);
    expect(saved[0]!.text).toBe('the gate code is 4321');

    await owner.post('/api/chat', { message: 'remind me to water the plants' });
    const voice = await owner.get('/api/chat/messages?mode=voice');
    const chat = await owner.get('/api/chat/messages');
    // The thread keeps the request without the wake phrase, exactly as the AI heard it.
    expect(voice.data.map((m: any) => m.content)).toContain('remember that the gate code is 4321');
    expect(JSON.stringify(voice.data)).not.toContain('water the plants');
    expect(JSON.stringify(chat.data)).toContain('water the plants');
  });

  it('tells the model to speak in short spoken words', async () => {
    const owner = await user('Spoken');
    await owner.post('/api/family', { name: 'Spoken' });
    sent.length = 0;
    await owner.withModel().post('/api/chat', { message: 'what is for dinner', mode: 'voice' });
    expect(sent[0]!.system).toContain('read out loud');
    expect(sent[0]!.system).toContain('at most two short sentences');
  });
});

describe('coder mode', () => {
  it('gets no tools at all, so a money request in it cannot spend anything', async () => {
    const owner = await user('Dev');
    await owner.post('/api/family', { name: 'Dev' });
    const r = await owner.post('/api/chat', { message: 'spent 600 on groceries', mode: 'coder' });
    expect(r.status).toBe(200);
    expect(r.data.outcomes).toEqual([]);
    const [member] = await db.select().from(schema.members).where(eq(schema.members.role, 'owner'));
    const rows = await db.select().from(schema.ledger).where(eq(schema.ledger.familyId, member!.familyId));
    expect(rows).toHaveLength(0);

    sent.length = 0;
    await owner.withModel().post('/api/chat', { message: 'write a bubble sort', mode: 'coder' });
    expect(sent[0]!.tools).toBeUndefined();
    expect(sent[0]!.system).toContain('coding mode');
  });

  it('refuses a tool call even if the model asks for one anyway', async () => {
    const owner = await user('Sneaky');
    await owner.post('/api/family', { name: 'Sneaky' });
    const me = (await owner.get('/api/me')).data;
    const [user1] = await db.select().from(schema.users).where(eq(schema.users.id, me.id));
    const [member] = await db.select().from(schema.members).where(eq(schema.members.id, me.member.id));
    const out = await invokeTool({ db, member: member!, user: user1!, mode: 'coder' }, 'send_money', { to: 'X', amount: 10 });
    expect(out).toMatchObject({ kind: 'failed' });
    expect(out.kind === 'failed' && out.text).toContain('Not available in coder mode');
    expect(await db.select().from(schema.approvals).where(eq(schema.approvals.familyId, member!.familyId))).toHaveLength(0);
  });
});

describe('learning coach', () => {
  it('logs what was worked on and counts a day streak, and cannot spend money', async () => {
    const kidOwner = await user('Teacher');
    await kidOwner.post('/api/family', { name: 'School' });
    const kid = await join(kidOwner, 'child', 'Kiddo');
    const r = await kid.post('/api/chat', { message: 'spent 600 on sweets', mode: 'learn' });
    expect(r.data.outcomes).toEqual([]); // no money tool in this mode
    const learning = await kid.get('/api/records/learning');
    expect(learning.data.streak).toBe(1);
    expect(learning.data.sessions).toBe(1);
    expect(learning.data.topics[0].text).toContain('sweets');

    sent.length = 0;
    await kid.withModel().post('/api/chat', { message: 'help me with fractions', mode: 'learn' });
    expect(sent[0]!.tools.map((t: any) => t.name).sort()).toEqual(['add_reminder', 'list_reminders', 'recall', 'remember']);
    expect(sent[0]!.system).toContain('Never just hand over the answer');
  });
});

describe('family twin', () => {
  it('needs the person to switch it on, and only uses what they shared', async () => {
    const owner = await user('Amma');
    await owner.post('/api/family', { name: 'Twins' });
    const dad = await join(owner, 'adult', 'Appa');
    const dadMemberId = (await dad.get('/api/me')).data.member.id;

    // Not on yet.
    expect((await owner.get('/api/family/twin')).data.people).toEqual([]);
    const refused = await owner.post('/api/chat', { message: 'what would Appa say?', mode: 'twin', twinOf: dadMemberId });
    expect(refused.status).toBe(403);

    await dad.post('/api/chat', { message: 'remember for family I always take the 8am bus' });
    await dad.post('/api/chat', { message: 'remember that my bank pin is 9999' }); // private
    expect((await dad.req('PATCH', '/api/me', { twinOptIn: true })).data.twinOptIn).toBe(true);
    expect((await owner.get('/api/family/twin')).data.people).toHaveLength(1);

    sent.length = 0;
    const r = await owner.withModel().post('/api/chat', { message: 'how does Appa get to work?', mode: 'twin', twinOf: dadMemberId });
    expect(r.status).toBe(200);
    const system = String(sent[0]!.system);
    expect(system).toContain('8am bus');
    expect(system).not.toContain('9999'); // private notes are never used
    expect(system).toContain('You are NOT Appa');
    expect(sent[0]!.tools.map((t: any) => t.name)).toEqual(['recall']);
  });

  it('keeps guests out of the extra modes', async () => {
    const owner = await user('Host');
    await owner.post('/api/family', { name: 'Guests' });
    const guest = await join(owner, 'guest', 'Visitor');
    expect((await guest.post('/api/chat', { message: 'hi', mode: 'coder' })).status).toBe(403);
    expect((await guest.post('/api/chat', { message: 'hi', mode: 'voice' })).status).toBe(200);
  });
});

describe('memory timeline', () => {
  it('shows the family story by month and hides other people\'s private notes', async () => {
    const owner = await user('Keeper');
    await owner.post('/api/family', { name: 'Story' });
    const teen = await join(owner, 'teen', 'Tween');
    await owner.post('/api/chat', { message: 'remember for family we go to Ooty every April' });
    await teen.post('/api/chat', { message: 'remember that I like Ananya' }); // private to the teen
    await owner.post('/api/chat', { message: 'add appliance: Fridge (Samsung, 2021)' });

    const mine = await owner.get('/api/records/timeline');
    const text = JSON.stringify(mine.data);
    expect(mine.data.months.length).toBeGreaterThan(0);
    expect(text).toContain('Ooty');
    expect(text).toContain('Fridge');
    expect(text).not.toContain('Ananya');
    expect((await teen.get('/api/records/timeline')).data.months.some((m: any) => JSON.stringify(m).includes('Ananya'))).toBe(true);
  });
});

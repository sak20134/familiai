// The real-model path, with the AI API faked so no key or network is needed.

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runTurn } from '../src/brain/agent';
import { decide, invokeTool } from '../src/brain/actions';
import { createDb, schema, type Db } from '../src/db/client';

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createDb());
  await db.insert(schema.users).values({ id: 'u1', email: 'u1@example.com', passwordHash: 'x', displayName: 'Asha', aiName: 'Nova' });
  await db.insert(schema.families).values({ id: 'f1', name: 'F' });
  await db.insert(schema.members).values({ id: 'm1', familyId: 'f1', userId: 'u1', role: 'owner' });
});
afterAll(async () => close());

const ctx = async () => {
  const [member] = await db.select().from(schema.members).where(eq(schema.members.id, 'm1'));
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, 'u1'));
  return { db, member: member!, user: user! };
};

/** Fake Anthropic API: returns the scripted responses in order and records requests. */
function fakeApi(responses: unknown[]) {
  const requests: any[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    if (!next) return new Response('no more', { status: 500 });
    return new Response(JSON.stringify(next), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe('model brain', () => {
  it('runs low-risk tools directly and feeds results back to the model', async () => {
    const { fetchImpl, requests } = fakeApi([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'remember', input: { text: 'Dad likes filter coffee', scope: 'family' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Saved! I will remember that.' }] },
    ]);
    const r = await runTurn(await ctx(), 'remember dad likes filter coffee', { apiKey: 'k', model: 'm', fetchImpl });
    expect(r.demo).toBe(false);
    expect(r.outcomes[0]).toMatchObject({ kind: 'done', tool: 'remember' });
    expect(r.reply).toBe('Saved! I will remember that.');
    expect(requests[0].tools.map((t: any) => t.name)).toContain('send_money');
    expect(requests[0].system).toContain('Nova');
    expect(JSON.stringify(requests[1].messages)).toContain('DONE: Saved to family memory.');
    const rows = await db.select().from(schema.memories).where(eq(schema.memories.familyId, 'f1'));
    expect(rows.some((x) => x.text.includes('filter coffee'))).toBe(true);
  });

  it('never runs money tools without approval, and adds the approval note if the model forgets', async () => {
    const { fetchImpl, requests } = fakeApi([
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'send_money', input: { to: 'Ravi', amount: 500 } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sending it now.' }] },
    ]);
    const r = await runTurn(await ctx(), 'pay Ravi 500', { apiKey: 'k', model: 'm', fetchImpl });
    expect(r.outcomes[0]).toMatchObject({ kind: 'needs_approval', tool: 'send_money' });
    expect(JSON.stringify(requests[1].messages)).toContain('WAITING FOR APPROVAL');
    expect(r.reply).toContain('I need your OK first');
    const pending = await db.select().from(schema.approvals).where(eq(schema.approvals.status, 'pending'));
    expect(pending).toHaveLength(1);
  });

  it('reports bad tool input and unknown tools as failures', async () => {
    const { fetchImpl } = fakeApi([
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't1', name: 'add_expense', input: { amount: -5, category: 'x' } },
        { type: 'tool_use', id: 't2', name: 'delete_everything', input: {} },
      ] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Those did not work.' }] },
    ]);
    const r = await runTurn(await ctx(), 'do stuff', { apiKey: 'k', model: 'm', fetchImpl });
    expect(r.outcomes.map((o) => o.kind)).toEqual(['failed', 'failed']);
  });

  it('surfaces API errors instead of inventing a reply', async () => {
    const fetchImpl = (async () => new Response('invalid x-api-key', { status: 401 })) as unknown as typeof fetch;
    await expect(runTurn(await ctx(), 'hi', { apiKey: 'bad', model: 'm', fetchImpl })).rejects.toThrow('401');
  });
});

describe('honesty and stuck approvals (review fixes)', () => {
  it('always states pending and failed actions, whatever the model claims', async () => {
    const { fetchImpl } = fakeApi([
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 't1', name: 'send_money', input: { to: 'Ravi', amount: 100 } },
        { type: 'tool_use', id: 't2', name: 'add_expense', input: { amount: -1, category: 'oops' } },
      ] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done! I approved and sent the money and logged the expense.' }] },
    ]);
    const r = await runTurn(await ctx(), 'pay and call', { apiKey: 'k', model: 'm', fetchImpl });
    expect(r.reply).toContain('I need your OK first: PAY');
    expect(r.reply).toContain("That didn't work");
  });
  it('an approval never stays stuck at "approved" when loading the requester fails', async () => {
    const c = await ctx();
    const o = await invokeTool(c, 'add_reminder', { text: 'water the plants' });
    expect(o.kind).toBe('needs_approval');
    const id = o.kind === 'needs_approval' ? o.approvalId : '';
    const out = await decide(db, c.member, id, 'approve', async () => { throw new Error('database is down'); });
    expect(out.ok && out.row.status).toBe('failed');
    const [row] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, id));
    expect(row!.status).toBe('failed');
    expect(row!.error).toContain('database is down');
  });
});

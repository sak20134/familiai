// Chat and approvals.

import { and, asc, desc, eq, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { asMember, body, fail, findMember, requireMember, type AppEnv } from '../context';
import { schema, type Db } from '../db/client';
import { decide, mayDecide, toRequest } from '../brain/actions';
import { runTurn, type BrainConfig } from '../brain/agent';
import type { ToolContext } from '../brain/tools';
import { can } from '@familiai/core';

async function contextFor(db: Db, familyId: string, memberId: string): Promise<ToolContext | null> {
  const member = await findMember(db, familyId, memberId);
  if (!member?.userId) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, member.userId));
  return user ? { db, member, user } : null;
}

export function chatRoutes(brain: BrainConfig) {
  const app = new Hono<AppEnv>();

  app.get('/messages', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const rows = await db.select({ id: schema.messages.id, role: schema.messages.role, content: schema.messages.content, createdAt: schema.messages.createdAt })
      .from(schema.messages).where(eq(schema.messages.memberId, me.id)).orderBy(desc(schema.messages.createdAt)).limit(100);
    return c.json(rows.reverse());
  });

  app.post('/', async (c) => {
    const me = requireMember(c);
    const input = await body(c, z.object({ message: z.string().trim().min(1).max(2000) }));
    try {
      const result = await runTurn({ db: c.get('db'), member: me, user: c.get('user') }, input.message, brain);
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'The AI could not answer.' }, 502);
    }
  });

  return app;
}

export function approvalRoutes() {
  const app = new Hono<AppEnv>();

  /** Requests this person may see: their own, plus ones they are allowed to decide. */
  app.get('/', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const status = c.req.query('status') === 'all' ? null : 'pending';
    const m = asMember(me);
    const scope = m.role === 'owner' || m.role === 'admin'
      ? eq(schema.approvals.familyId, me.familyId)
      : can(m, 'approve_money')
        ? or(eq(schema.approvals.requestedBy, me.id), eq(schema.approvals.risk, 'money'))
        : eq(schema.approvals.requestedBy, me.id);
    const rows = await db.select().from(schema.approvals)
      .where(and(eq(schema.approvals.familyId, me.familyId), scope, status ? eq(schema.approvals.status, status) : undefined))
      .orderBy(asc(schema.approvals.createdAt)).limit(100);
    const now = Date.now();
    return c.json(rows.map((r) => {
      const req = toRequest(r, now);
      return { id: r.id, tool: r.tool, risk: r.risk, summary: r.summary, status: req.status, error: r.error, result: r.result,
        requestedBy: r.requestedBy, createdAt: r.createdAt, canDecide: req.status === 'pending' && mayDecide(me, r) };
    }).filter((r) => status === null || r.status === 'pending'));
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/:id/${decision}`, async (c) => {
      const db = c.get('db');
      const me = requireMember(c);
      const out = await decide(db, me, c.req.param('id'), decision, (requesterId) => contextFor(db, me.familyId, requesterId));
      if (!out.ok) fail(out.error === 'not_found' ? 404 : out.error === 'forbidden' ? 403 : 409, out.message);
      return c.json({ status: out.row.status, message: out.message });
    });
  }

  return app;
}

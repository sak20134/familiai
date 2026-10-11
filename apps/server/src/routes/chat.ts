// Chat and approvals.

import { and, asc, desc, eq, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { asMember, body, fail, findMember, logActivity, requireMember, type AppEnv } from '../context';
import { schema, type Db } from '../db/client';
import { decide, mayDecide, toRequest } from '../brain/actions';
import { runTurn, type BrainConfig } from '../brain/agent';
import type { ToolContext } from '../brain/tools';
import { canRead, isMode, modeAllowed, stripWake, wakePhrases, type MemoryItem, type Mode } from '@familiai/core';
import { can } from '@familiai/core';
import type { Services } from '../services/types';

const TWIN_FACTS = 20;

/**
 * Family Twin facts: only notes the target CHOSE to share (never private ones), and only the
 * ones the person asking is allowed to read anyway. So the twin can never leak anything.
 */
async function twinFor(db: Db, familyId: string, me: ReturnType<typeof requireMember>, targetId: string) {
  const [target] = await db
    .select({ member: schema.members, user: schema.users })
    .from(schema.members).leftJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(and(eq(schema.members.id, targetId), eq(schema.members.familyId, familyId)));
  if (!target) fail(404, 'No such family member.');
  if (!target.user?.twinOptIn) fail(403, 'That person has not switched on their Family Twin yet.');
  const name = target.member.nickname ?? target.user.displayName ?? 'they';
  const rows = await db.select().from(schema.memories)
    .where(and(eq(schema.memories.familyId, familyId), eq(schema.memories.ownerId, targetId)))
    .orderBy(desc(schema.memories.createdAt)).limit(100);
  const facts = rows
    .filter((r) => r.scope !== 'private')
    .map((r): MemoryItem => ({
      id: r.id, familyId: r.familyId, ownerId: r.ownerId, scope: r.scope as MemoryItem['scope'], text: r.text,
      sensitivity: r.sensitivity as MemoryItem['sensitivity'], source: r.source, confidence: r.confidence, createdAt: r.createdAt.getTime(),
    }))
    .filter((item) => canRead(asMember(me), item))
    .slice(0, TWIN_FACTS)
    .map((item) => item.text);
  return { name, facts };
}

async function contextFor(db: Db, familyId: string, memberId: string, services?: Services): Promise<ToolContext | null> {
  const member = await findMember(db, familyId, memberId);
  if (!member?.userId) return null;
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, member.userId));
  // Approved actions always run with full checks: AI Mode never applies at approval time.
  return user ? { db, member, user, ...(services ? { services } : {}) } : null;
}

export function chatRoutes(brain: BrainConfig, services?: Services) {
  const app = new Hono<AppEnv>();

  /** One thread per mode: ?mode=voice shows only what was said in Voice. */
  app.get('/messages', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const q = c.req.query('mode');
    const mode: Mode = isMode(q) ? q : 'chat';
    const rows = await db.select({ id: schema.messages.id, role: schema.messages.role, content: schema.messages.content, createdAt: schema.messages.createdAt })
      .from(schema.messages).where(and(eq(schema.messages.memberId, me.id), eq(schema.messages.mode, mode)))
      .orderBy(desc(schema.messages.createdAt)).limit(100);
    return c.json(rows.reverse());
  });

  app.post('/', async (c) => {
    const me = requireMember(c);
    const input = await body(c, z.object({
      message: z.string().trim().min(1).max(2000),
      mode: z.enum(['chat', 'voice', 'coder', 'learn', 'twin']).default('chat'),
      twinOf: z.string().trim().min(1).max(60).optional(),
    }));
    const mode: Mode = input.mode;
    if (!modeAllowed(mode, asMember(me).role)) fail(403, `Your family role cannot use ${mode} mode.`);
    if (mode === 'twin' && !input.twinOf) fail(400, 'Say whose twin to ask.');
    const db = c.get('db');
    const twin = mode === 'twin' && input.twinOf ? await twinFor(db, me.familyId, me, input.twinOf) : undefined;
    try {
      const user = c.get('user');
      // Voice: "Hey Nova, what's for dinner" reaches the AI as "what's for dinner".
      const said = mode === 'voice'
        ? stripWake(input.message, wakePhrases([user.aiName ?? 'Buddy', ...user.aliases])) ?? input.message
        : input.message;
      // AI Mode never applies to the twin: it only ever talks.
      const autonomy = { aiMode: mode !== 'twin' && user.aiMode && can(asMember(me), 'use_ai_mode'), standing: new Set<string>() };
      const result = await runTurn(
        { db, member: me, user, autonomy, mode, ...(twin ? { twin } : {}), ...(services ? { services } : {}) },
        said,
        brain,
      );
      // The Learning Coach keeps a light trail, so the timeline can show what they worked on.
      if (mode === 'learn') {
        await logActivity(db, me.familyId, me.id, 'learning', `Learning: ${input.message.slice(0, 60)}`);
      }
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'The AI could not answer.' }, 502);
    }
  });

  return app;
}

export function approvalRoutes(services?: Services) {
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
      const out = await decide(db, me, c.req.param('id'), decision, (requesterId) => contextFor(db, me.familyId, requesterId, services));
      if (!out.ok) fail(out.error === 'not_found' ? 404 : out.error === 'forbidden' ? 403 : 409, out.message);
      return c.json({ status: out.row.status, message: out.message });
    });
  }

  return app;
}

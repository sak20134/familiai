// Connections (Google), the Google sign-in return page, and daily check-in plans.

import { can, type Role } from '@familiai/core';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { asMember, body, fail, findMember, logActivity, requireMember, type AppEnv } from '../context';
import { schema } from '../db/client';
import { newId } from '../security';
import { consumeState, finishGoogleAuth, revokeConnection, startGoogleAuth } from '../services/google';
import type { Services } from '../services/types';

export function connectionRoutes(services: Services) {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const rows = await c.get('db').select().from(schema.connections).where(eq(schema.connections.userId, c.get('user').id));
    return c.json({
      googleConfigured: Boolean(services.google),
      connections: rows.map((r) => ({ id: r.id, provider: r.provider, accountLabel: r.accountLabel, scopes: r.scopes, status: r.status, lastError: r.lastError, connectedAt: r.connectedAt })),
    });
  });

  app.post('/google/start', (c) => {
    if (!services.google) fail(409, 'Google is not set up on this server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.');
    return c.json({ url: startGoogleAuth(services.google, c.get('user').id) });
  });

  app.delete('/:id', async (c) => {
    try {
      await revokeConnection(c.get('db'), services, c.get('user').id, c.req.param('id'));
    } catch (err) {
      fail(409, err instanceof Error ? err.message : 'Could not revoke.');
    }
    return c.json({ ok: true });
  });

  return app;
}

/** Google sends the browser back here after the user agrees. */
export function oauthRoutes(services: Services) {
  const app = new Hono<AppEnv>();
  app.get('/google/callback', async (c) => {
    const user = c.get('user');
    const code = c.req.query('code');
    const state = c.req.query('state') ?? '';
    if (!services.google) return c.redirect('/?connect=not-configured');
    if (c.req.query('error') || !code) return c.redirect('/?connect=cancelled');
    if (!consumeState(state, user.id)) return c.redirect('/?connect=expired');
    try {
      await finishGoogleAuth(c.get('db'), services, user.id, code);
      const member = c.get('member');
      if (member) await logActivity(c.get('db'), member.familyId, member.id, 'connected', 'Connected Google Calendar.');
      return c.redirect('/?connect=google');
    } catch {
      return c.redirect('/?connect=failed');
    }
  });
  return app;
}

const planInput = z.object({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  utcOffsetMinutes: z.number().int().min(-720).max(840),
  graceMinutes: z.number().int().min(5).max(240).default(30),
  enabled: z.boolean().default(true),
});

export function checkinRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const admin = can(asMember(me), 'manage_members');
    const rows = await db.select().from(schema.checkInPlans)
      .where(and(eq(schema.checkInPlans.familyId, me.familyId), admin ? undefined : eq(schema.checkInPlans.memberId, me.id)));
    return c.json(rows.map((r) => ({ memberId: r.memberId, hour: r.hour, minute: r.minute, utcOffsetMinutes: r.utcOffsetMinutes,
      graceMinutes: r.graceMinutes, enabled: r.enabled, lastAnsweredAt: r.lastAnsweredAt, missCount: r.missCount })));
  });

  /** Family admins set who gets a daily check-in and when. */
  app.put('/:memberId', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    if (!can(asMember(me), 'manage_members')) fail(403, 'Only family admins can set check-ins.');
    const target = await findMember(db, me.familyId, c.req.param('memberId'));
    if (!target) fail(404, 'No such family member.');
    const input = await body(c, planInput);
    const [existing] = await db.select().from(schema.checkInPlans).where(eq(schema.checkInPlans.memberId, target.id));
    if (existing) await db.update(schema.checkInPlans).set(input).where(eq(schema.checkInPlans.id, existing.id));
    else await db.insert(schema.checkInPlans).values({ id: newId('chk'), familyId: me.familyId, memberId: target.id, ...input });
    await logActivity(db, me.familyId, me.id, 'checkin_plan', `Daily check-in set for a ${target.role as Role} at ${String(input.hour).padStart(2, '0')}:${String(input.minute).padStart(2, '0')}.`);
    return c.json({ ok: true });
  });

  /** "I'm okay": answers today's check-in and resets the miss counter. */
  app.post('/answer', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const updated = await db.update(schema.checkInPlans).set({ lastAnsweredAt: new Date(), missCount: 0 })
      .where(eq(schema.checkInPlans.memberId, me.id)).returning();
    if (updated.length === 0) fail(404, 'You have no daily check-in set.');
    await logActivity(db, me.familyId, me.id, 'checkin_ok', 'Checked in: all okay.');
    return c.json({ ok: true });
  });

  return app;
}

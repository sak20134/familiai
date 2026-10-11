// Family server: create a family, invite people, change roles, remove members.
// Every rule comes from @familiai/core (canManage, can) and is checked here on the server.

import { can, canManage, ROLES, type Role } from '@familiai/core';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { asMember, body, fail, findMember, logActivity, requireMember, type AppEnv } from '../context';
import { schema } from '../db/client';
import { newId, newInviteCode, type Limits } from '../security';
import { clientIp } from './auth';

const INVITE_DAYS = 7;
const assignable = z.enum(ROLES).refine((r) => r !== 'owner', 'The owner role cannot be given out.');

export function familyRoutes() {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const db = c.get('db');
    if (c.get('member')) fail(409, 'You are already in a family.');
    const input = await body(c, z.object({ name: z.string().trim().min(1).max(60) }));
    const familyId = newId('fam');
    const memberId = newId('mem');
    const user = c.get('user');
    await db.transaction(async (tx) => {
      await tx.insert(schema.families).values({ id: familyId, name: input.name });
      await tx.insert(schema.members).values({ id: memberId, familyId, userId: user.id, role: 'owner' });
    });
    await logActivity(db, familyId, memberId, 'family_created', `${user.displayName ?? 'Someone'} created the family "${input.name}".`);
    return c.json({ familyId, memberId }, 201);
  });

  app.get('/', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const [family] = await db.select().from(schema.families).where(eq(schema.families.id, me.familyId));
    const people = await db
      .select({
        id: schema.members.id,
        role: schema.members.role,
        nickname: schema.members.nickname,
        displayName: schema.users.displayName,
      })
      .from(schema.members)
      .leftJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(eq(schema.members.familyId, me.familyId));
    const meAsMember = asMember(me);
    return c.json({
      family,
      me: { id: me.id, role: me.role },
      members: people.map((p) => ({
        ...p,
        canManage: canManage(meAsMember, { id: p.id, familyId: me.familyId, role: p.role as Role }),
      })),
    });
  });

  /** Family Twin: who has switched theirs on, so you can ask what they would probably say. */
  app.get('/twin', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const people = await db
      .select({ id: schema.members.id, nickname: schema.members.nickname, displayName: schema.users.displayName, optIn: schema.users.twinOptIn })
      .from(schema.members).innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(eq(schema.members.familyId, me.familyId));
    return c.json({
      mine: people.find((p) => p.id === me.id)?.optIn ?? false,
      people: people.filter((p) => p.optIn).map((p) => ({ id: p.id, name: p.nickname ?? p.displayName ?? 'Member' })),
    });
  });

  app.post('/invites', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    if (!can(asMember(me), 'manage_members')) fail(403, 'Only family admins can invite people.');
    const input = await body(c, z.object({ role: assignable }));
    if (input.role === 'admin' && me.role !== 'owner') fail(403, 'Only the owner can invite another admin.');
    const code = newInviteCode();
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 3600_000);
    await db.insert(schema.invites).values({ code, familyId: me.familyId, role: input.role, createdBy: me.id, expiresAt });
    await logActivity(db, me.familyId, me.id, 'invite_created', `An invite for a new ${input.role} was created.`);
    return c.json({ code, role: input.role, expiresAt }, 201);
  });

  app.patch('/members/:id', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const target = await findMember(db, me.familyId, c.req.param('id'));
    if (!target) fail(404, 'No such family member.');
    if (!canManage(asMember(me), asMember(target))) fail(403, 'You cannot change this member.');
    const input = await body(c, z.object({ role: assignable }));
    if (input.role === 'admin' && me.role !== 'owner') fail(403, 'Only the owner can make someone an admin.');
    await db.update(schema.members).set({ role: input.role }).where(eq(schema.members.id, target.id));
    await logActivity(db, me.familyId, me.id, 'role_changed', `A member's role changed from ${target.role} to ${input.role}.`);
    return c.json({ ok: true });
  });

  app.delete('/members/:id', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const target = await findMember(db, me.familyId, c.req.param('id'));
    if (!target) fail(404, 'No such family member.');
    if (!canManage(asMember(me), asMember(target))) fail(403, 'You cannot remove this member.');
    await db.delete(schema.members).where(eq(schema.members.id, target.id));
    await logActivity(db, me.familyId, me.id, 'member_removed', `A ${target.role} was removed from the family.`);
    return c.json({ ok: true });
  });

  return app;
}

export function inviteRoutes(limits: Limits) {
  const { inviteGuesses } = limits;
  const app = new Hono<AppEnv>();

  app.post('/accept', async (c) => {
    const db = c.get('db');
    if (c.get('member')) fail(409, 'You are already in a family.');
    const ip = clientIp(c);
    if (inviteGuesses.blocked(ip)) fail(429, 'Too many wrong codes. Wait 15 minutes and try again.');
    const input = await body(c, z.object({ code: z.string().trim().toUpperCase().length(8, 'Invite codes have 8 characters.') }));
    const user = c.get('user');
    const memberId = newId('mem');
    const joined = await db.transaction(async (tx) => {
      // Mark the invite used in the same step that checks it, so one code cannot be used twice.
      const [invite] = await tx
        .update(schema.invites)
        .set({ usedBy: user.id })
        .where(and(eq(schema.invites.code, input.code), isNull(schema.invites.usedBy), gt(schema.invites.expiresAt, new Date())))
        .returning();
      if (!invite) return null;
      await tx.insert(schema.members).values({ id: memberId, familyId: invite.familyId, userId: user.id, role: invite.role });
      return invite;
    });
    if (!joined) {
      inviteGuesses.hit(ip);
      fail(404, 'That invite code is wrong, used or expired.');
    }
    await logActivity(db, joined.familyId, memberId, 'member_joined', `${user.displayName ?? 'Someone'} joined as ${joined.role}.`);
    return c.json({ familyId: joined.familyId, memberId, role: joined.role });
  });

  return app;
}

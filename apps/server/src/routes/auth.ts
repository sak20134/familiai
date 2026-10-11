// Sign up, log in, log out, and the current user's profile and onboarding answers.

import { ageModeFor, can, wakePhrases } from '@familiai/core';
import { and, eq, gt } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { asMember, body, fail, type AppEnv, type Ctx } from '../context';
import { schema, type Db } from '../db/client';
import { hashPassword, newId, newToken, sha256, verifyPassword, type Limits } from '../security';

export const SESSION_COOKIE = 'fa_session';
const SESSION_DAYS = 30;

/** The caller's network address, or 'local' when unknown (tests, some proxies). */
export function clientIp(c: Ctx): string {
  try {
    return getConnInfo(c).remote.address ?? 'local';
  } catch {
    return 'local';
  }
}

/** Loads the signed-in user and their family membership. Routes after it can rely on c.get('user'). */
export function requireUser(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('db', db);
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) fail(401, 'Please log in.');
    const [row] = await db
      .select({ user: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, new Date())));
    if (!row) fail(401, 'Your session expired. Please log in again.');
    const [member] = await db.select().from(schema.members).where(eq(schema.members.userId, row.user.id)).limit(1);
    c.set('user', row.user);
    c.set('member', member ?? null);
    await next();
  };
}

async function startSession(c: Ctx, db: Db, userId: string): Promise<void> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 3600_000);
  await db.insert(schema.sessions).values({ tokenHash: sha256(token), userId, expiresAt });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: new URL(c.req.url).protocol === 'https:',
    path: '/',
    expires: expiresAt,
  });
}

const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(8, 'Use at least 8 characters.').max(200);

export function profile(user: typeof schema.users.$inferSelect, member: typeof schema.members.$inferSelect | null) {
  const age = user.birthYear ? new Date().getUTCFullYear() - user.birthYear : null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    aiName: user.aiName ?? 'Buddy',
    birthYear: user.birthYear,
    ageMode: age === null ? null : ageModeFor(Math.max(0, age)),
    botLook: user.botLook,
    botRole: user.botRole,
    onboarded: user.onboarded,
    aiMode: user.aiMode,
    twinOptIn: user.twinOptIn,
    aliases: user.aliases,
    wakePhrases: wakePhrases([user.aiName ?? 'Buddy', ...user.aliases]),
    member: member && { id: member.id, familyId: member.familyId, role: member.role, nickname: member.nickname, phone: member.phone },
  };
}

export function authRoutes(db: Db, limits: Limits) {
  const { loginFailures, loginFailuresPerIp, signups } = limits;
  const app = new Hono<AppEnv>();

  app.post('/signup', async (c) => {
    if (!signups.allow(clientIp(c))) fail(429, 'Too many new accounts from here. Try again later.');
    const input = await body(c, z.object({ email, password, displayName: z.string().trim().min(1).max(60) }));
    const [existing] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, input.email));
    if (existing) fail(409, 'That email already has an account. Log in instead.');
    const id = newId('usr');
    await db.insert(schema.users).values({
      id,
      email: input.email,
      passwordHash: await hashPassword(input.password),
      displayName: input.displayName,
    });
    await startSession(c, db, id);
    return c.json({ ok: true }, 201);
  });

  app.post('/login', async (c) => {
    const input = await body(c, z.object({ email, password: z.string().max(200) }));
    const ip = clientIp(c);
    const key = `${ip}|${input.email}`;
    if (loginFailures.blocked(key) || loginFailuresPerIp.blocked(ip)) fail(429, 'Too many attempts. Wait 15 minutes and try again.');
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, input.email));
    // Same message for "no such user" and "wrong password", so emails cannot be probed.
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      loginFailures.hit(key);
      loginFailuresPerIp.hit(ip);
      fail(401, 'Email or password is wrong.');
    }
    await startSession(c, db, user.id);
    return c.json({ ok: true });
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  return app;
}

export function meRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/', (c) => c.json(profile(c.get('user'), c.get('member'))));

  app.patch('/', async (c) => {
    const db = c.get('db');
    const thisYear = new Date().getUTCFullYear();
    const input = await body(
      c,
      z.object({
        displayName: z.string().trim().min(1).max(60).optional(),
        aiName: z.string().trim().min(1).max(30).optional(),
        birthYear: z.number().int().min(thisYear - 120).max(thisYear).optional(),
        botLook: z.string().trim().min(1).max(40).optional(),
        botRole: z.string().trim().min(1).max(40).optional(),
        nickname: z.string().trim().min(1).max(40).optional(),
        phone: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +919876543210').optional(),
        aiMode: z.boolean().optional(),
        twinOptIn: z.boolean().optional(),
        aliases: z.array(z.string().trim().min(1).max(30)).max(5).optional(),
        onboarded: z.literal(true).optional(),
      }),
    );
    const { nickname, phone, ...userFields } = input;
    const user = c.get('user');
    const current = c.get('member');
    if (input.aiMode === true && !(current && can(asMember(current), 'use_ai_mode'))) {
      fail(403, 'Your family role cannot turn on AI Mode.');
    }
    if (Object.keys(userFields).length > 0) {
      await db.update(schema.users).set(userFields).where(eq(schema.users.id, user.id));
    }
    const member = c.get('member');
    if ((nickname || phone) && member) {
      await db.update(schema.members).set({ ...(nickname ? { nickname } : {}), ...(phone ? { phone } : {}) }).where(eq(schema.members.id, member.id));
    }
    const [fresh] = await db.select().from(schema.users).where(eq(schema.users.id, user.id));
    const [freshMember] = await db.select().from(schema.members).where(eq(schema.members.userId, user.id)).limit(1);
    return c.json(profile(fresh!, freshMember ?? null));
  });

  return app;
}

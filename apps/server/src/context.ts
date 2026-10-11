// Shared server types and small helpers used by every route.

import type { Member } from '@familiai/core';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';
import { schema, type Db } from './db/client';
import { newId } from './security';

export type UserRow = typeof schema.users.$inferSelect;
export type MemberRow = typeof schema.members.$inferSelect;

export interface AppEnv {
  Variables: {
    db: Db;
    user: UserRow;
    /** The user's family membership, or null before they create or join a family. */
    member: MemberRow | null;
  };
}

export type Ctx = Context<AppEnv>;

export function fail(status: 400 | 401 | 403 | 404 | 409 | 429, message: string): never {
  throw new HTTPException(status, { message });
}

/** Parse a JSON body with a zod schema; bad input becomes a clear 400. */
export async function body<T extends z.ZodType>(c: Ctx, shape: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    fail(400, 'Send a JSON body.');
  }
  const parsed = shape.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    fail(400, first ? `${first.path.join('.') || 'input'}: ${first.message}` : 'Invalid input.');
  }
  return parsed.data;
}

/** The current member, or a 409 telling the user to create or join a family first. */
export function requireMember(c: Ctx): MemberRow {
  const m = c.get('member');
  if (!m) fail(409, 'Create or join a family first.');
  return m;
}

export const asMember = (m: MemberRow): Member => ({ id: m.id, familyId: m.familyId, role: m.role as Member['role'] });

export async function findMember(db: Db, familyId: string, memberId: string): Promise<MemberRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.members)
    .where(and(eq(schema.members.id, memberId), eq(schema.members.familyId, familyId)));
  return row;
}

/** Writes one line to the family activity feed. */
export async function logActivity(db: Db, familyId: string, memberId: string | null, kind: string, summary: string): Promise<void> {
  await db.insert(schema.activity).values({ id: newId('act'), familyId, memberId, kind, summary: summary.slice(0, 500) });
}

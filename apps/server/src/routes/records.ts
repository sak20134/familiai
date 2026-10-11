// Memory, deleted-items vault, activity feed, money summary and reminders.

import {
  can, canRead, filterReadable, summarize, timelineKindFor, timelineMonths,
  type MemoryItem, type TimelineEntry,
} from '@familiai/core';
import { and, desc, eq, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { asMember, fail, logActivity, requireMember, type AppEnv } from '../context';
import { schema } from '../db/client';
import { newId } from '../security';

const VAULT_KEEP_DAYS = 180;

const toItem = (r: typeof schema.memories.$inferSelect): MemoryItem => ({
  id: r.id, familyId: r.familyId, ownerId: r.ownerId, scope: r.scope as MemoryItem['scope'], text: r.text,
  sensitivity: r.sensitivity as MemoryItem['sensitivity'], source: r.source, confidence: r.confidence,
  createdAt: r.createdAt.getTime(), ...(r.expiresAt ? { expiresAt: r.expiresAt.getTime() } : {}),
});

export function recordRoutes() {
  const app = new Hono<AppEnv>();

  app.get('/memories', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const rows = await db.select().from(schema.memories).where(eq(schema.memories.familyId, me.familyId))
      .orderBy(desc(schema.memories.createdAt)).limit(200);
    const visible = filterReadable(asMember(me), rows.map(toItem));
    return c.json(visible.map((m) => ({ id: m.id, text: m.text, scope: m.scope, mine: m.ownerId === me.id, createdAt: m.createdAt })));
  });

  /** Deleting moves the memory into the protected vault (kept for a while, then purged). */
  app.delete('/memories/:id', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const [row] = await db.select().from(schema.memories)
      .where(and(eq(schema.memories.id, c.req.param('id')), eq(schema.memories.familyId, me.familyId)));
    if (!row || !canRead(asMember(me), toItem(row))) fail(404, 'No such memory.');
    const isAdmin = me.role === 'owner' || me.role === 'admin';
    if (row.ownerId !== me.id && !(isAdmin && row.scope !== 'private')) fail(403, 'You can only delete your own memories.');
    await db.transaction(async (tx) => {
      await tx.insert(schema.vaultItems).values({
        id: newId('vlt'), familyId: me.familyId, memberId: row.ownerId, kind: 'memory',
        // Private memories stay private after deletion: their text is NOT kept, so no admin can read it.
        payload: row.scope === 'private' ? { scope: 'private', deletedBy: me.id } : { text: row.text, scope: row.scope, deletedBy: me.id },
        purgeAfter: new Date(Date.now() + VAULT_KEEP_DAYS * 24 * 3600_000),
      });
      await tx.delete(schema.memories).where(eq(schema.memories.id, row.id));
    });
    await logActivity(db, me.familyId, me.id, 'memory_deleted', `Deleted a ${row.scope} memory (kept in the vault for ${VAULT_KEEP_DAYS} days).`);
    return c.json({ ok: true });
  });

  /** Admin view of deleted items. Every view is logged, and the owner of each item is told. */
  app.get('/vault', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    if (!can(asMember(me), 'view_vault')) fail(403, 'Only family admins can open the vault.');
    // Keep the promise: items past their keep date are removed for good before anyone looks.
    await db.delete(schema.vaultItems).where(and(eq(schema.vaultItems.familyId, me.familyId), lt(schema.vaultItems.purgeAfter, new Date())));
    const items = await db.select().from(schema.vaultItems).where(eq(schema.vaultItems.familyId, me.familyId))
      .orderBy(desc(schema.vaultItems.deletedAt)).limit(100);
    if (items.length > 0) {
      await db.insert(schema.vaultAccess).values(items.map((i) => ({ id: newId('vac'), familyId: me.familyId, viewerId: me.id, itemId: i.id })));
      const owners = [...new Set(items.map((i) => i.memberId))].filter((id) => id !== me.id);
      for (const owner of owners) {
        await logActivity(db, me.familyId, owner, 'vault_viewed', `A family admin viewed your deleted items.`);
      }
    }
    return c.json(items.map((i) => {
      const p = i.payload as { scope?: string; text?: string };
      // Defense in depth: never show the text of someone else's private item, even if an old row has it.
      const payload = p.scope === 'private' && i.memberId !== me.id ? { scope: 'private', text: '(private, hidden)' } : p;
      return { id: i.id, kind: i.kind, memberId: i.memberId, payload, deletedAt: i.deletedAt, purgeAfter: i.purgeAfter };
    }));
  });

  app.get('/activity', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const everyone = can(asMember(me), 'view_activity');
    const rows = await db.select().from(schema.activity)
      .where(and(eq(schema.activity.familyId, me.familyId), everyone ? undefined : eq(schema.activity.memberId, me.id)))
      .orderBy(desc(schema.activity.createdAt)).limit(100);
    return c.json(rows.map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, memberId: r.memberId, createdAt: r.createdAt })));
  });

  app.get('/money/summary', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    if (!can(asMember(me), 'view_money')) fail(403, 'Ask a parent or family admin to see family spending.');
    const q = c.req.query('period');
    const period = q === 'today' || q === '3months' || q === 'year' ? q : 'month';
    const rows = await db.select().from(schema.ledger).where(eq(schema.ledger.familyId, me.familyId));
    return c.json({ period, ...summarize(rows.map((r) => ({ ...r, memberId: r.memberId ?? '', at: r.at.getTime() })), period) });
  });

  app.get('/reminders', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const rows = await db.select().from(schema.reminders)
      .where(and(eq(schema.reminders.memberId, me.id), eq(schema.reminders.done, false))).orderBy(desc(schema.reminders.createdAt));
    return c.json(rows.map((r) => ({ id: r.id, text: r.text, dueAt: r.dueAt })));
  });

  app.get('/house', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const rows = await db.select().from(schema.houseItems).where(eq(schema.houseItems.familyId, me.familyId)).orderBy(desc(schema.houseItems.createdAt));
    return c.json(rows.map((r) => ({ id: r.id, kind: r.kind, name: r.name, details: r.details, dueAt: r.dueAt })));
  });

  /** Family Memory Timeline: the family's story, month by month. Private notes stay private. */
  app.get('/timeline', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const m = asMember(me);
    const [memories, acts, house] = await Promise.all([
      db.select().from(schema.memories).where(eq(schema.memories.familyId, me.familyId)).orderBy(desc(schema.memories.createdAt)).limit(300),
      db.select().from(schema.activity).where(and(eq(schema.activity.familyId, me.familyId),
        can(m, 'view_activity') ? undefined : eq(schema.activity.memberId, me.id))).orderBy(desc(schema.activity.createdAt)).limit(300),
      db.select().from(schema.houseItems).where(eq(schema.houseItems.familyId, me.familyId)).limit(100),
    ]);
    const entries: TimelineEntry[] = [
      ...filterReadable(m, memories.map(toItem)).map((x) => ({
        id: x.id, kind: 'memory' as const, text: x.text, at: x.createdAt, ...(x.ownerId ? { memberId: x.ownerId } : {}),
      })),
      ...acts.flatMap((a) => {
        const kind = timelineKindFor(a.kind);
        return kind ? [{ id: a.id, kind, text: a.summary, at: a.createdAt.getTime(), ...(a.memberId ? { memberId: a.memberId } : {}) }] : [];
      }),
      ...house.map((x) => ({ id: x.id, kind: 'house' as const, text: `${x.name}${x.details ? `: ${x.details}` : ''}`, at: x.createdAt.getTime() })),
    ];
    const months = timelineMonths(entries);
    return c.json({ total: entries.length, months: months.slice(0, 24) });
  });

  /** Kids Learning Coach: what they have been working on, and how many days in a row. */
  app.get('/learning', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const rows = await db.select().from(schema.activity)
      .where(and(eq(schema.activity.familyId, me.familyId), eq(schema.activity.memberId, me.id), eq(schema.activity.kind, 'learning')))
      .orderBy(desc(schema.activity.createdAt)).limit(100);
    const days = [...new Set(rows.map((r) => r.createdAt.toISOString().slice(0, 10)))].sort().reverse();
    let streak = 0;
    for (let i = 0; i < days.length; i++) {
      const expected = new Date(Date.now() - i * 24 * 3600_000).toISOString().slice(0, 10);
      if (days[i] === expected) streak++;
      else break;
    }
    return c.json({
      streak,
      sessions: rows.length,
      topics: rows.slice(0, 20).map((r) => ({ text: r.summary.replace(/^Learning: /, ''), at: r.createdAt })),
    });
  });

  /** Family Hub: one screen with money, approvals, reminders, house, check-ins and recent activity. */
  app.get('/hub', async (c) => {
    const db = c.get('db');
    const me = requireMember(c);
    const m = asMember(me);
    const [ledger, pending, reminders, house, members, recent, plans] = await Promise.all([
      can(m, 'view_money') ? db.select().from(schema.ledger).where(eq(schema.ledger.familyId, me.familyId)) : Promise.resolve(null),
      db.select().from(schema.approvals).where(and(eq(schema.approvals.familyId, me.familyId), eq(schema.approvals.status, 'pending'))),
      db.select().from(schema.reminders).where(and(eq(schema.reminders.memberId, me.id), eq(schema.reminders.done, false))),
      db.select().from(schema.houseItems).where(eq(schema.houseItems.familyId, me.familyId)),
      db.select({ id: schema.members.id }).from(schema.members).where(eq(schema.members.familyId, me.familyId)),
      db.select().from(schema.activity).where(and(eq(schema.activity.familyId, me.familyId),
        can(m, 'view_activity') ? undefined : eq(schema.activity.memberId, me.id))).orderBy(desc(schema.activity.createdAt)).limit(5),
      db.select().from(schema.checkInPlans).where(eq(schema.checkInPlans.familyId, me.familyId)),
    ]);
    const mine = plans.find((p) => p.memberId === me.id);
    return c.json({
      moneyThisMonth: ledger ? summarize(ledger.map((r) => ({ ...r, memberId: r.memberId ?? '', at: r.at.getTime() })), 'month').totalMinor : null,
      pendingApprovals: pending.filter((p) => p.requestedBy === me.id || m.role === 'owner' || m.role === 'admin' || (p.risk === 'money' && can(m, 'approve_money'))).length,
      reminders: reminders.map((r) => r.text).slice(0, 5),
      houseItems: house.length,
      houseDue: house.filter((h) => h.dueAt && h.dueAt.getTime() < Date.now() + 7 * 24 * 3600_000).map((h) => h.name).slice(0, 5),
      members: members.length,
      checkInAlerts: can(m, 'manage_members') ? plans.filter((p) => p.missCount > 0).length : 0,
      myCheckIn: mine ? { answeredToday: Boolean(mine.lastAnsweredAt && Date.now() - mine.lastAnsweredAt.getTime() < 20 * 3600_000) } : null,
      recent: recent.map((r) => ({ summary: r.summary, createdAt: r.createdAt })),
    });
  });

  return app;
}

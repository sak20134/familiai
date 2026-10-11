// The things the AI can do. Each tool has a risk level, a plain summary for the approval card,
// an action, and an independent check that the action really happened.

import {
  canWrite,
  type Autonomy,
  type Capability,
  GoogleCalendar,
  filterReadable,
  makeExpense,
  resolveContact,
  summarize,
  type MemoryItem,
  type Risk,
  type ToolSpec,
} from '@familiai/core';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import { z } from 'zod';
import { asMember, logActivity, type MemberRow, type UserRow } from '../context';
import { schema, type Db } from '../db/client';
import { newId } from '../security';
import { googleTokens } from '../services/google';
import type { Services } from '../services/types';

export interface ToolContext {
  db: Db;
  member: MemberRow;
  user: UserRow;
  /** AI Mode and standing permissions for this person (default: none). */
  autonomy?: Autonomy;
  services?: Services;
}

export interface ToolResult {
  text: string;
  data?: Record<string, unknown>;
}

export interface BrainTool<S extends z.ZodType = z.ZodType> {
  spec: ToolSpec;
  /** The capability the person ASKING must have (approval rules are separate). */
  requires: Capability;
  input: S;
  summarize(args: z.infer<S>): string;
  run(ctx: ToolContext, args: z.infer<S>): Promise<ToolResult>;
  verify(ctx: ToolContext, result: ToolResult): Promise<boolean>;
}

function tool<S extends z.ZodType>(name: string, risk: Risk, requires: Capability, description: string, def: Omit<BrainTool<S>, 'spec' | 'requires'>): BrainTool<S> {
  return { spec: { name, risk, description }, requires, ...def };
}

const exists = async (db: Db, table: typeof schema.memories | typeof schema.ledger | typeof schema.reminders, id: unknown) =>
  typeof id === 'string' && (await db.select({ id: table.id }).from(table).where(eq(table.id, id))).length === 1;

const toItem = (r: typeof schema.memories.$inferSelect): MemoryItem => ({
  id: r.id,
  familyId: r.familyId,
  ownerId: r.ownerId,
  scope: r.scope as MemoryItem['scope'],
  text: r.text,
  sensitivity: r.sensitivity as MemoryItem['sensitivity'],
  source: r.source,
  confidence: r.confidence,
  createdAt: r.createdAt.getTime(),
  ...(r.expiresAt ? { expiresAt: r.expiresAt.getTime() } : {}),
});

const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export const remember = tool(
  'remember',
  'low',
  'chat',
  'Save a fact to memory. scope: private (only me), family (whole family) or house (home facts like appliances).',
  {
    input: z.object({ text: z.string().trim().min(2).max(500), scope: z.enum(['private', 'family', 'house']).default('private') }),
    summarize: (a) => `Remember (${a.scope}): "${a.text}"`,
    async run({ db, member }, a) {
      if (!canWrite(asMember(member), a.scope)) throw new Error(`You can only save private memories.`);
      const id = newId('mem');
      await db.insert(schema.memories).values({
        id, familyId: member.familyId, ownerId: member.id, scope: a.scope, text: a.text, source: 'chat', confidence: 0.9,
      });
      if (a.scope !== 'private') await logActivity(db, member.familyId, member.id, 'memory_saved', `Saved a ${a.scope} memory.`);
      return { text: `Saved to ${a.scope} memory.`, data: { id } };
    },
    verify: ({ db }, r) => exists(db, schema.memories, r.data?.id),
  },
);

export const recall = tool('recall', 'low', 'chat', 'Search memories this person is allowed to see.', {
  input: z.object({ query: z.string().trim().min(2).max(200) }),
  summarize: (a) => `Search memory for "${a.query}"`,
  async run({ db, member }, a) {
    const words = a.query.toLowerCase().split(/\W+/).filter((w) => w.length >= 3).slice(0, 6);
    const match = words.length ? or(...words.map((w) => ilike(schema.memories.text, `%${w}%`))) : undefined;
    const rows = await db
      .select()
      .from(schema.memories)
      .where(and(eq(schema.memories.familyId, member.familyId), match))
      .orderBy(desc(schema.memories.createdAt))
      .limit(50);
    const visible = filterReadable(asMember(member), rows.map(toItem)).slice(0, 8);
    if (visible.length === 0) return { text: 'Nothing saved about that yet.', data: { count: 0 } };
    return { text: visible.map((m) => `- ${m.text} (${m.scope})`).join('\n'), data: { count: visible.length } };
  },
  verify: async () => true,
});

export const addExpense = tool('add_expense', 'medium', 'log_expenses', 'Record money already spent in the family ledger. amount is in rupees (major units).', {
  input: z.object({
    amount: z.number().positive().max(10_000_000),
    category: z.string().trim().min(1).max(40),
    note: z.string().trim().max(200).default(''),
    currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  }),
  summarize: (a) => `Add expense: ${money(Math.round(a.amount * 100), a.currency)} for ${a.category}`,
  async run({ db, member }, a) {
    const entry = makeExpense({
      id: newId('led'), familyId: member.familyId, memberId: member.id, amountMinor: Math.round(a.amount * 100),
      currency: a.currency, category: a.category.toLowerCase(), note: a.note, at: Date.now(),
    });
    await db.insert(schema.ledger).values({ ...entry, at: new Date(entry.at) });
    await logActivity(db, member.familyId, member.id, 'expense_added', `Added ${money(entry.amountMinor, entry.currency)} for ${entry.category}.`);
    return { text: `Added ${money(entry.amountMinor, entry.currency)} for ${entry.category}.`, data: { id: entry.id } };
  },
  verify: ({ db }, r) => exists(db, schema.ledger, r.data?.id),
});

export const moneySummary = tool('money_summary', 'low', 'view_money', 'Total family spending for a period, by category.', {
  input: z.object({ period: z.enum(['today', 'month', '3months', 'year']).default('month') }),
  summarize: (a) => `Show spending for ${a.period}`,
  async run({ db, member }, a) {
    const rows = await db.select().from(schema.ledger).where(eq(schema.ledger.familyId, member.familyId));
    const s = summarize(rows.map((r) => ({ ...r, memberId: r.memberId ?? '', at: r.at.getTime() })), a.period);
    if (s.count === 0) return { text: `No spending recorded for ${a.period}.`, data: { totalMinor: 0 } };
    const parts = Object.entries(s.byCategory).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${money(v, 'INR')}`);
    return { text: `Total for ${a.period}: ${money(s.totalMinor, 'INR')} (${parts.join(', ')}).`, data: { totalMinor: s.totalMinor } };
  },
  verify: async () => true,
});

export const addReminder = tool('add_reminder', 'medium', 'chat', 'Create a reminder for this person. dueAt is optional ISO 8601 date-time.', {
  input: z.object({ text: z.string().trim().min(2).max(300), dueAt: z.iso.datetime({ offset: true }).optional() }),
  summarize: (a) => `Remind: "${a.text}"${a.dueAt ? ` at ${a.dueAt}` : ''}`,
  async run({ db, member }, a) {
    const id = newId('rem');
    await db.insert(schema.reminders).values({ id, familyId: member.familyId, memberId: member.id, text: a.text, dueAt: a.dueAt ? new Date(a.dueAt) : null });
    return { text: `Reminder saved: ${a.text}`, data: { id } };
  },
  verify: ({ db }, r) => exists(db, schema.reminders, r.data?.id),
});

export const listReminders = tool('list_reminders', 'low', 'chat', "List this person's open reminders.", {
  input: z.object({}),
  summarize: () => 'Show my reminders',
  async run({ db, member }) {
    const rows = await db.select().from(schema.reminders)
      .where(and(eq(schema.reminders.memberId, member.id), eq(schema.reminders.done, false))).limit(20);
    return { text: rows.length ? rows.map((r) => `- ${r.text}`).join('\n') : 'No open reminders.', data: { count: rows.length } };
  },
  verify: async () => true,
});

export const callFamilyMember = tool('call_family_member', 'high', 'use_calls', 'Phone a family member by name, nickname or relation (e.g. "Dad").', {
  input: z.object({ who: z.string().trim().min(1).max(60) }),
  summarize: (a) => `Phone call to ${a.who}`,
  async run(ctx, a) {
    const { db, member } = ctx;
    const people = await db
      .select({ id: schema.members.id, nickname: schema.members.nickname, name: schema.users.displayName, phone: schema.members.phone })
      .from(schema.members).leftJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(eq(schema.members.familyId, member.familyId));
    const contacts = people.map((p) => ({ id: p.id, name: p.name ?? '', aliases: p.nickname ? [p.nickname] : [], phone: '' }));
    const found = resolveContact(a.who, contacts);
    if (found.kind === 'none') throw new Error(`I couldn't find "${a.who}" in your family.`);
    if (found.kind === 'ambiguous') throw new Error(`More than one person matches "${a.who}": ${found.candidates.map((x) => x.name).join(', ')}. Say who exactly.`);
    const calls = ctx.services?.calls;
    if (!calls) throw new Error(`Phone calls are not connected yet (add a Twilio account in .env), so I did not call ${found.contact.name}.`);
    const phone = people.find((p) => p.id === found.contact.id)?.phone;
    if (!phone) throw new Error(`${found.contact.name} has no phone number saved. They can add it in Settings.`);
    const caller = ctx.member.nickname ?? ctx.user.displayName ?? 'Your family';
    const { callId } = await calls.provider.startCall({ to: phone, from: calls.from, say: `Hello ${found.contact.name}, ${caller} asked Family AI to call you.` });
    await logActivity(db, member.familyId, member.id, 'call_placed', `Called ${found.contact.name}.`);
    return { text: `Calling ${found.contact.name} now.`, data: { callId } };
  },
  verify: async (_ctx, r) => typeof r.data?.callId === 'string' && r.data.callId.length > 0,
});

export const sendMoney = tool('send_money', 'money', 'chat', 'Pay or transfer real money. Always needs a person to approve, every time.', {
  input: z.object({ to: z.string().trim().min(1).max(80), amount: z.number().positive().max(10_000_000), currency: z.string().regex(/^[A-Z]{3}$/).default('INR') }),
  summarize: (a) => `PAY ${money(Math.round(a.amount * 100), a.currency)} to ${a.to}`,
  async run(_ctx, a) {
    throw new Error(`Payments are not connected yet, so no money was sent to ${a.to}.`);
  },
  verify: async () => false,
});

const calendar = (ctx: ToolContext) => {
  if (!ctx.services?.google) throw new Error('Google Calendar is not set up on this server yet.');
  return new GoogleCalendar(googleTokens(ctx.db, ctx.services), ctx.services.fetchImpl);
};

export const listCalendar = tool('list_calendar_events', 'low', 'chat', "Read this person's next Google Calendar events.", {
  input: z.object({ max: z.number().int().min(1).max(10).default(5) }),
  summarize: () => 'Show my next calendar events',
  async run(ctx, a) {
    const events = await calendar(ctx).listUpcoming(ctx.user.id, new Date(), a.max);
    return { text: events.length ? events.map((e) => `- ${e.summary} (${e.start})`).join('\n') : 'Nothing coming up on your calendar.', data: { count: events.length } };
  },
  verify: async () => true,
});

export const addCalendarEvent = tool('add_calendar_event', 'medium', 'chat', 'Create a Google Calendar event. start and end are ISO 8601 date-times with offset.', {
  input: z.object({ title: z.string().trim().min(1).max(120), start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }),
  summarize: (a) => `Add to calendar: "${a.title}" ${a.start} to ${a.end}`,
  async run(ctx, a) {
    const ev = await calendar(ctx).createEvent(ctx.user.id, { summary: a.title, start: a.start, end: a.end });
    await logActivity(ctx.db, ctx.member.familyId, ctx.member.id, 'calendar_event', `Added "${a.title}" to Google Calendar.`);
    return { text: `Added "${a.title}" to your calendar.`, data: { eventId: ev.id } };
  },
  verify: async (ctx, r) => typeof r.data?.eventId === 'string' && calendar(ctx).eventExists(ctx.user.id, r.data.eventId),
});

export const addHouseItem = tool('add_house_item', 'low', 'edit_family_memory', 'Save House Knowledge: an appliance, inventory item, maintenance task or home fact.', {
  input: z.object({
    kind: z.enum(['appliance', 'inventory', 'maintenance', 'fact']),
    name: z.string().trim().min(1).max(80),
    details: z.string().trim().max(300).default(''),
    dueAt: z.iso.datetime({ offset: true }).optional(),
  }),
  summarize: (a) => `Save to house (${a.kind}): ${a.name}`,
  async run({ db, member }, a) {
    const id = newId('hse');
    await db.insert(schema.houseItems).values({ id, familyId: member.familyId, kind: a.kind, name: a.name, details: a.details, dueAt: a.dueAt ? new Date(a.dueAt) : null, createdBy: member.id });
    await logActivity(db, member.familyId, member.id, 'house_item', `Saved ${a.kind}: ${a.name}.`);
    return { text: `Saved to House Knowledge: ${a.name}.`, data: { id } };
  },
  verify: async ({ db }, r) => typeof r.data?.id === 'string' && (await db.select({ id: schema.houseItems.id }).from(schema.houseItems).where(eq(schema.houseItems.id, r.data.id))).length === 1,
});

export const listHouse = tool('list_house', 'low', 'chat', 'List House Knowledge items (appliances, inventory, maintenance, facts).', {
  input: z.object({ kind: z.enum(['appliance', 'inventory', 'maintenance', 'fact']).optional() }),
  summarize: () => 'Show house items',
  async run({ db, member }, a) {
    const rows = await db.select().from(schema.houseItems)
      .where(and(eq(schema.houseItems.familyId, member.familyId), a.kind ? eq(schema.houseItems.kind, a.kind) : undefined)).limit(30);
    return { text: rows.length ? rows.map((r) => `- ${r.name} (${r.kind})${r.details ? `: ${r.details}` : ''}`).join('\n') : 'Nothing saved about the house yet.', data: { count: rows.length } };
  },
  verify: async () => true,
});

export const TOOLS: readonly BrainTool[] = [
  remember, recall, addExpense, moneySummary, addReminder, listReminders, callFamilyMember, sendMoney,
  listCalendar, addCalendarEvent, addHouseItem, listHouse,
] as BrainTool[];
export const toolByName = (name: string): BrainTool | undefined => TOOLS.find((t) => t.spec.name === name);

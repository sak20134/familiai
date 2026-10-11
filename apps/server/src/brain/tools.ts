// The things the AI can do. Each tool has a risk level, a plain summary for the approval card,
// an action, and an independent check that the action really happened.

import {
  canWrite,
  type Capability,
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

export interface ToolContext {
  db: Db;
  member: MemberRow;
  user: UserRow;
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
  async run({ db, member }, a) {
    const people = await db
      .select({ id: schema.members.id, nickname: schema.members.nickname, name: schema.users.displayName })
      .from(schema.members).leftJoin(schema.users, eq(schema.users.id, schema.members.userId))
      .where(eq(schema.members.familyId, member.familyId));
    const contacts = people.map((p) => ({ id: p.id, name: p.name ?? '', aliases: p.nickname ? [p.nickname] : [], phone: '' }));
    const found = resolveContact(a.who, contacts);
    if (found.kind === 'none') throw new Error(`I couldn't find "${a.who}" in your family.`);
    if (found.kind === 'ambiguous') throw new Error(`More than one person matches "${a.who}": ${found.candidates.map((x) => x.name).join(', ')}. Say who exactly.`);
    // Honest: no phone provider is connected in this version, so we never pretend the call happened.
    throw new Error(`Phone calls are not connected yet (needs a Twilio or Speko account), so I did not call ${found.contact.name}.`);
  },
  verify: async () => false,
});

export const sendMoney = tool('send_money', 'money', 'chat', 'Pay or transfer real money. Always needs a person to approve, every time.', {
  input: z.object({ to: z.string().trim().min(1).max(80), amount: z.number().positive().max(10_000_000), currency: z.string().regex(/^[A-Z]{3}$/).default('INR') }),
  summarize: (a) => `PAY ${money(Math.round(a.amount * 100), a.currency)} to ${a.to}`,
  async run(_ctx, a) {
    throw new Error(`Payments are not connected yet, so no money was sent to ${a.to}.`);
  },
  verify: async () => false,
});

export const TOOLS: readonly BrainTool[] = [remember, recall, addExpense, moneySummary, addReminder, listReminders, callFamilyMember, sendMoney] as BrainTool[];
export const toolByName = (name: string): BrainTool | undefined => TOOLS.find((t) => t.spec.name === name);

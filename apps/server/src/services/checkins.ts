// Daily check-ins and Emergency escalation. Runs every minute from index.ts.
// Each missed check-in is handled once; repeated misses escalate (see escalationFor in core).

import { escalationFor, evaluate, lastDue } from '@familiai/core';
import { and, eq, inArray } from 'drizzle-orm';
import { logActivity } from '../context';
import { schema, type Db } from '../db/client';
import type { Services } from './types';

export interface CheckInEvent {
  memberId: string;
  action: string;
  ok: boolean;
}

const ADMIN_ROLES = ['owner', 'admin'];

async function nameOf(db: Db, memberId: string): Promise<string> {
  const [row] = await db.select({ nick: schema.members.nickname, name: schema.users.displayName })
    .from(schema.members).leftJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(eq(schema.members.id, memberId));
  return row?.nick ?? row?.name ?? 'A family member';
}

async function tryCall(services: Services | undefined, phone: string | null, say: string): Promise<boolean> {
  if (!services?.calls || !phone) return false;
  try {
    await services.calls.provider.startCall({ to: phone, from: services.calls.from, say });
    return true;
  } catch {
    return false;
  }
}

export async function runCheckIns(db: Db, services: Services | undefined, now = Date.now()): Promise<CheckInEvent[]> {
  const events: CheckInEvent[] = [];
  const plans = await db.select().from(schema.checkInPlans).where(eq(schema.checkInPlans.enabled, true));
  for (const plan of plans) {
    const p = { memberId: plan.memberId, hour: plan.hour, minute: plan.minute, utcOffsetMinutes: plan.utcOffsetMinutes, graceMinutes: plan.graceMinutes };
    const due = lastDue(p, now);
    const status = evaluate(p, plan.lastAnsweredAt?.getTime(), now);
    if (status !== 'missed' || plan.lastHandledDue?.getTime() === due) continue;

    const misses = plan.missCount + 1;
    await db.update(schema.checkInPlans).set({ missCount: misses, lastHandledDue: new Date(due) }).where(eq(schema.checkInPlans.id, plan.id));
    const step = escalationFor(misses);
    const who = await nameOf(db, plan.memberId);
    const [member] = await db.select().from(schema.members).where(eq(schema.members.id, plan.memberId));
    const admins = await db.select().from(schema.members)
      .where(and(eq(schema.members.familyId, plan.familyId), inArray(schema.members.role, ADMIN_ROLES)));

    if (step.action === 'retry_call') {
      const ok = await tryCall(services, member?.phone ?? null, `Hello ${who}, this is your daily check-in. Please open Family AI and tap I'm okay.`);
      await logActivity(db, plan.familyId, plan.memberId, 'checkin_missed', `${who} missed today's check-in.${ok ? ' I called to remind them.' : ''}`);
      events.push({ memberId: plan.memberId, action: step.action, ok });
    } else if (step.action === 'notify_admins') {
      for (const a of admins) await logActivity(db, plan.familyId, a.id, 'checkin_alert', `${who} has missed ${misses} check-ins in a row. Please check on them.`);
      events.push({ memberId: plan.memberId, action: step.action, ok: true });
    } else if (step.action === 'call_emergency_contact') {
      let anyCall = false;
      for (const a of admins) {
        await logActivity(db, plan.familyId, a.id, 'emergency', `EMERGENCY: ${who} has missed ${misses} check-ins in a row.`);
        anyCall = (await tryCall(services, a.phone, `Emergency alert from Family AI: ${who} has missed ${misses} check-ins. Please check on them now.`)) || anyCall;
      }
      events.push({ memberId: plan.memberId, action: step.action, ok: anyCall });
    }
  }
  return events;
}

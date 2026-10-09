// Step 26: daily check-in calls and the Emergency Mode escalation rules.

export interface CheckInPlan {
  memberId: string;
  hour: number; // local hour 0-23
  minute: number; // local minute 0-59
  utcOffsetMinutes: number; // e.g. India = 330
  graceMinutes: number; // how long to wait for an answer
}

const DAY = 24 * 60 * 60_000;

function validate(plan: CheckInPlan): void {
  if (!Number.isInteger(plan.hour) || plan.hour < 0 || plan.hour > 23) throw new RangeError('hour must be 0-23');
  if (!Number.isInteger(plan.minute) || plan.minute < 0 || plan.minute > 59) throw new RangeError('minute must be 0-59');
  if (plan.graceMinutes < 0) throw new RangeError('graceMinutes must be >= 0');
}

/** Most recent scheduled check-in time at or before `now` (epoch ms). */
export function lastDue(plan: CheckInPlan, now: number): number {
  validate(plan);
  const local = now + plan.utcOffsetMinutes * 60_000;
  const startOfLocalDay = Math.floor(local / DAY) * DAY;
  let due = startOfLocalDay + (plan.hour * 60 + plan.minute) * 60_000;
  if (due > local) due -= DAY;
  return due - plan.utcOffsetMinutes * 60_000;
}

export function nextDue(plan: CheckInPlan, now: number): number {
  return lastDue(plan, now) + DAY;
}

export type CheckInStatus = 'ok' | 'waiting' | 'missed';

/** `lastAnsweredAt` is when the member last answered a check-in (epoch ms), if ever. */
export function evaluate(plan: CheckInPlan, lastAnsweredAt: number | undefined, now: number): CheckInStatus {
  const due = lastDue(plan, now);
  if (lastAnsweredAt !== undefined && lastAnsweredAt >= due) return 'ok';
  return now > due + plan.graceMinutes * 60_000 ? 'missed' : 'waiting';
}

export type EscalationStep =
  | { level: 0; action: 'none' }
  | { level: 1; action: 'retry_call' }
  | { level: 2; action: 'notify_admins' }
  | { level: 3; action: 'call_emergency_contact' };

/** How hard to escalate after N consecutive misses. Emergency Mode starts at level 3. */
export function escalationFor(consecutiveMisses: number): EscalationStep {
  if (consecutiveMisses <= 0) return { level: 0, action: 'none' };
  if (consecutiveMisses === 1) return { level: 1, action: 'retry_call' };
  if (consecutiveMisses === 2) return { level: 2, action: 'notify_admins' };
  return { level: 3, action: 'call_emergency_contact' };
}

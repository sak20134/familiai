// Step 22 (money part): ledger and Money Center summaries. Amounts are integer minor units (paise/cents).

import type { ToolSpec } from './approvals';

export interface LedgerEntry {
  id: string;
  familyId: string;
  memberId: string;
  amountMinor: number;
  currency: string;
  category: string;
  note: string;
  at: number; // epoch ms
}

/** Logging an expense the user told us about is medium risk. */
export const ADD_EXPENSE_TOOL: ToolSpec = {
  name: 'money.add_expense',
  risk: 'medium',
  description: 'Record an expense in the family ledger',
};

/** Moving real money is ALWAYS approved by a person, every time, even in AI Mode. */
export const PAY_TOOL: ToolSpec = {
  name: 'money.pay',
  risk: 'money',
  description: 'Pay or transfer real money',
};

export function makeExpense(input: Omit<LedgerEntry, 'id'> & { id?: string }): LedgerEntry {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new RangeError('amountMinor must be a positive integer');
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new RangeError('currency must be a 3-letter code like INR');
  return { ...input, id: input.id ?? `led_${input.at}_${input.memberId}` };
}

export type Period = 'today' | 'month' | '3months' | 'year';

function startOf(period: Period, now: Date): number {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  switch (period) {
    case 'today':
      return Date.UTC(y, m, now.getUTCDate());
    case 'month':
      return Date.UTC(y, m, 1);
    case '3months':
      return Date.UTC(y, m - 2, 1);
    case 'year':
      return Date.UTC(y, 0, 1);
  }
}

export interface Summary {
  totalMinor: number;
  count: number;
  byCategory: Record<string, number>;
}

export function summarize(entries: readonly LedgerEntry[], period: Period, now = new Date()): Summary {
  const from = startOf(period, now);
  const to = now.getTime();
  const out: Summary = { totalMinor: 0, count: 0, byCategory: {} };
  for (const e of entries) {
    if (e.at < from || e.at > to) continue;
    out.totalMinor += e.amountMinor;
    out.count += 1;
    out.byCategory[e.category] = (out.byCategory[e.category] ?? 0) + e.amountMinor;
  }
  return out;
}

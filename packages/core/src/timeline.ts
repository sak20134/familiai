// Family Memory Timeline: everything the family saved, grouped by month, newest first.

export type TimelineKind = 'memory' | 'moment' | 'house' | 'money' | 'learning';

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  text: string;
  at: number;
  /** The member this entry belongs to, when it belongs to one person. */
  memberId?: string;
}

export interface TimelineMonth {
  /** Sortable key, e.g. "2026-10". */
  month: string;
  label: string;
  entries: TimelineEntry[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Groups entries into months, newest month and newest entry first. */
export function timelineMonths(entries: readonly TimelineEntry[]): TimelineMonth[] {
  const byMonth = new Map<string, TimelineEntry[]>();
  for (const e of entries) {
    const d = new Date(e.at);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const list = byMonth.get(key);
    if (list) list.push(e);
    else byMonth.set(key, [e]);
  }
  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([month, list]) => {
      const [year, m] = month.split('-');
      return {
        month,
        label: `${MONTHS[Number(m) - 1] ?? month} ${year}`,
        entries: list.sort((a, b) => b.at - a.at),
      };
    });
}

/** Activity kinds worth keeping in a family's story, with friendlier wording. */
// Memories and house items are already on the timeline themselves, so their "saved" notes are left out.
const KEEP: Record<string, TimelineKind> = {
  expense_added: 'money',
  calendar_event: 'moment',
  call_placed: 'moment',
  learning: 'learning',
  member_joined: 'moment',
  check_in_missed: 'moment',
  emergency_raised: 'moment',
};

export const timelineKindFor = (activityKind: string): TimelineKind | null => KEEP[activityKind] ?? null;

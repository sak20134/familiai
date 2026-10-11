// Demo brain: understands a few common requests without any AI model, so the app works
// (and can be tested) before you add a key. It produces the same tool calls a model would.

export interface PlannedCall {
  tool: string;
  args: Record<string, unknown>;
}

const num = (s: string) => Number(s.replace(/,/g, ''));

export function planDemo(message: string): PlannedCall | null {
  const m = message.trim();

  let r = m.match(/\b(?:spent|paid|spend)\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:rs\.?|rupees|inr)?\s+(?:on|for)\s+(?:the\s+)?([a-z][a-z ]{0,38})/i);
  if (r) return { tool: 'add_expense', args: { amount: num(r[1]!), category: r[2]!.trim().split(/\s+/).slice(0, 2).join(' ') } };

  r = m.match(/\b(?:pay|send|transfer)\s+(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:rs\.?|rupees|inr)?\s+to\s+(.{1,60})$/i);
  if (r) return { tool: 'send_money', args: { amount: num(r[1]!), to: r[2]!.trim() } };

  r = m.match(/^remember(?:\s+(?:that|this))?(?:\s+for\s+(?:the\s+)?(family|house|home))?[:,]?\s+(.{2,500})$/i);
  if (r) {
    const where = r[1]?.toLowerCase();
    const scope = where === 'family' ? 'family' : where === 'house' || where === 'home' ? 'house' : 'private';
    return { tool: 'remember', args: { text: r[2]!.trim(), scope } };
  }

  r = m.match(/\b(?:what do you (?:remember|know) about|recall|do you remember)\s+(.{2,200}?)\??$/i);
  if (r) return { tool: 'recall', args: { query: r[1]!.trim() } };

  if (/\bhow much\b.*\b(spen[dt]|spending)\b|\bspending (?:summary|report)\b|\bmoney summary\b/i.test(m)) {
    const period = /\btoday\b/i.test(m) ? 'today' : /\byear\b/i.test(m) ? 'year' : /\b3 months|three months\b/i.test(m) ? '3months' : 'month';
    return { tool: 'money_summary', args: { period } };
  }

  r = m.match(/^remind me (?:to\s+)?(.{2,300})$/i);
  if (r) return { tool: 'add_reminder', args: { text: r[1]!.trim() } };

  if (/\b(my reminders|what are my reminders|show reminders|list reminders)\b/i.test(m)) return { tool: 'list_reminders', args: {} };

  r = m.match(/^(?:please\s+)?(?:call|phone|ring)\s+(.{1,60}?)[.!]?$/i);
  if (r) return { tool: 'call_family_member', args: { who: r[1]!.trim() } };

  return null;
}

export function demoSmallTalk(message: string, aiName: string, userName: string): string {
  if (/^(hi|hello|hey|namaste|vanakkam)\b/i.test(message.trim())) {
    return `Hi ${userName}! I'm ${aiName}. I'm in demo mode, so I understand things like "spent 600 on groceries", "remember that ...", "remind me to ...", "how much did we spend this month" or "call Dad".`;
  }
  return `I'm in demo mode, so I can only do a few things yet: log expenses, remember facts, set reminders, show spending, and (with approval) calls and payments. Add an AI key for full conversations.`;
}

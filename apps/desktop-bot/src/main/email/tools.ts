// Email tools for the AI. Read-only; only adults see them, because email is private.

import { fail, num, ok, str, type ToolDef } from '../agent/types';
import type { Gmail } from './gmail';

export function emailTools(gmail: Gmail): ToolDef[] {
  return [
    {
      spec: { name: 'check_email', risk: 'low', description: 'Check Gmail: list recent unread messages (or search with a Gmail query such as "from:mom"). Read-only.' },
      input: { type: 'object', properties: { query: { type: 'string', description: 'Gmail search, default "is:unread in:inbox"' }, max: { type: 'number', description: 'How many, 1 to 10. Default 5.' } } },
      roles: ['owner', 'admin', 'adult', 'elder'],
      async run(a) {
        if (!gmail.connected) return fail('Gmail is not connected. Open Settings and press Connect Gmail.');
        const mails = await gmail.check(str(a.query, 200) || undefined, num(a.max) || 5);
        if (!mails.length) return ok('No messages found.');
        return ok(mails.map((m, i) => `${i + 1}. [${m.id}] ${m.unread ? 'UNREAD ' : ''}From ${m.from} — ${m.subject} (${m.when || m.date})\n   ${m.snippet}`).join('\n'));
      },
    },
    {
      spec: { name: 'read_email', risk: 'low', description: 'Read one Gmail message by its id (from check_email). Read-only.' },
      input: { type: 'object', properties: { id: { type: 'string', description: 'Message id from check_email' } }, required: ['id'] },
      roles: ['owner', 'admin', 'adult', 'elder'],
      async run(a) {
        if (!gmail.connected) return fail('Gmail is not connected. Open Settings and press Connect Gmail.');
        const m = await gmail.read(str(a.id, 100));
        return ok(`From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.text}`);
      },
    },
  ];
}

// Step 25: phone calls. Contact resolution + a provider interface + a Twilio provider.
// Calling is HIGH risk: it always goes through the approval flow first.

import type { ToolSpec } from './approvals';

export const CALL_TOOL: ToolSpec = {
  name: 'phone.call',
  risk: 'high',
  description: 'Place a phone call to a contact',
};

export interface Contact {
  id: string;
  name: string;
  aliases: string[]; // "Dad", "Appa", "Papa"
  phone: string; // E.164, e.g. +919876543210
}

export type Resolution =
  | { kind: 'match'; contact: Contact }
  | { kind: 'ambiguous'; candidates: Contact[] }
  | { kind: 'none' };

/** "Call Dad": exact name/alias first, then prefix. More than one hit means ask the user. */
export function resolveContact(query: string, contacts: readonly Contact[]): Resolution {
  const q = query.trim().toLowerCase();
  if (!q) return { kind: 'none' };
  const names = (c: Contact) => [c.name, ...c.aliases].map((n) => n.toLowerCase());
  let hits = contacts.filter((c) => names(c).includes(q));
  if (hits.length === 0) hits = contacts.filter((c) => names(c).some((n) => n.startsWith(q)));
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length === 1) return { kind: 'match', contact: hits[0]! };
  return { kind: 'ambiguous', candidates: hits };
}

export interface CallRequest {
  to: string;
  from: string;
  say?: string;
}

export interface CallProvider {
  startCall(req: CallRequest): Promise<{ callId: string }>;
}

const E164 = /^\+[1-9]\d{6,14}$/;

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fetchImpl?: typeof fetch;
}

export class TwilioProvider implements CallProvider {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: TwilioConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async startCall(req: CallRequest): Promise<{ callId: string }> {
    if (!E164.test(req.to) || !E164.test(req.from)) throw new Error('Phone numbers must be in +E.164 format');
    const twiml = `<Response><Say>${escapeXml(req.say ?? 'Hello, this is a call from your family assistant.')}</Say></Response>`;
    const body = new URLSearchParams({ To: req.to, From: req.from, Twiml: twiml });
    const auth = Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString('base64');
    const res = await this.fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Calls.json`,
      {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
    );
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      throw new Error(`Twilio call failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { sid?: string };
    if (!json.sid) throw new Error('Twilio did not return a call id');
    return { callId: json.sid };
  }
}

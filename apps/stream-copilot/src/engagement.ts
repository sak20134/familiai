// Keeping chat alive: !commands with cooldowns, timed messages that skip a dead chat,
// polls with one vote per person, and giveaways drawn fairly.

import { isStaff, type ChatMessage } from './types';

// --- Commands --------------------------------------------------------------------------------

export interface CommandDef {
  name: string;
  /** What to say. {user} becomes the asker's name. */
  reply: string;
  cooldownMs: number;
  staffOnly: boolean;
}

export class Commands {
  private defs = new Map<string, CommandDef>();
  private lastUsed = new Map<string, number>();

  /** Adds or replaces a command. Names are case-insensitive and stored without the "!". */
  set(name: string, reply: string, opts: Partial<Pick<CommandDef, 'cooldownMs' | 'staffOnly'>> = {}): CommandDef {
    const key = name.replace(/^!/, '').trim().toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(key)) throw new Error('Command names are 1-25 letters, numbers or underscores.');
    const def = { name: key, reply: reply.trim().slice(0, 400), cooldownMs: opts.cooldownMs ?? 10_000, staffOnly: opts.staffOnly ?? false };
    this.defs.set(key, def);
    return def;
  }

  remove(name: string): boolean {
    return this.defs.delete(name.replace(/^!/, '').toLowerCase());
  }

  list(): CommandDef[] {
    return [...this.defs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The reply to post, or null when it is not a command, is on cooldown, or is staff-only. */
  handle(msg: ChatMessage): string | null {
    const m = msg.text.trim().match(/^!([a-z0-9_]{1,25})\b/i);
    if (!m) return null;
    const key = m[1]!.toLowerCase();
    if (key === 'commands') {
      const names = this.list().filter((d) => !d.staffOnly).map((d) => `!${d.name}`);
      return names.length ? `Commands: ${names.join(' ')}` : null;
    }
    const def = this.defs.get(key);
    if (!def) return null;
    if (def.staffOnly && !isStaff(msg.badges)) return null;
    const last = this.lastUsed.get(key) ?? Number.NEGATIVE_INFINITY;
    if (!isStaff(msg.badges) && msg.at - last < def.cooldownMs) return null;
    this.lastUsed.set(key, msg.at);
    return def.reply.replaceAll('{user}', msg.displayName);
  }
}

// --- Timed messages --------------------------------------------------------------------------

export interface TimedMessage {
  id: string;
  text: string;
  everyMs: number;
  /** Only post if at least this many chat messages arrived since the last post. Keeps a quiet chat from being spammed. */
  minChatLines: number;
}

export class Timers {
  private items = new Map<string, TimedMessage & { lastAt: number; linesSince: number }>();

  add(t: TimedMessage, now: number): void {
    this.items.set(t.id, { ...t, lastAt: now, linesSince: 0 });
  }

  remove(id: string): boolean {
    return this.items.delete(id);
  }

  /** Call for every chat line. */
  sawChat(): void {
    for (const t of this.items.values()) t.linesSince++;
  }

  /** Messages due now. Call about once a minute. */
  due(now: number): string[] {
    const out: string[] = [];
    for (const t of this.items.values()) {
      if (now - t.lastAt >= t.everyMs && t.linesSince >= t.minChatLines) {
        out.push(t.text);
        t.lastAt = now;
        t.linesSince = 0;
      }
    }
    return out;
  }
}

// --- Polls ------------------------------------------------------------------------------------

export class Poll {
  private votes = new Map<string, number>();
  readonly options: readonly string[];
  open = true;

  constructor(readonly question: string, options: readonly string[]) {
    const clean = options.map((o) => o.trim()).filter(Boolean);
    if (clean.length < 2 || clean.length > 10) throw new Error('A poll needs 2 to 10 options.');
    this.options = clean;
  }

  /** "!vote 2" style. One vote per person; voting again changes their vote. Returns false if ignored. */
  vote(userId: string, choice: number): boolean {
    if (!this.open || !Number.isInteger(choice) || choice < 1 || choice > this.options.length) return false;
    this.votes.set(userId, choice - 1);
    return true;
  }

  handle(msg: ChatMessage): boolean {
    const m = msg.text.trim().match(/^!vote\s+(\d{1,2})\b/i);
    return m ? this.vote(msg.userId, Number(m[1])) : false;
  }

  results(): Array<{ option: string; votes: number; percent: number }> {
    const counts = this.options.map(() => 0);
    for (const v of this.votes.values()) counts[v] = (counts[v] ?? 0) + 1;
    const total = this.votes.size;
    return this.options.map((option, i) => ({ option, votes: counts[i] ?? 0, percent: total ? Math.round(((counts[i] ?? 0) / total) * 100) : 0 }));
  }

  announce(): string {
    return `Poll: ${this.question} — ${this.options.map((o, i) => `!vote ${i + 1} for ${o}`).join(', ')}`;
  }

  close(): string {
    this.open = false;
    const r = this.results();
    const total = r.reduce((n, x) => n + x.votes, 0);
    if (total === 0) return `Poll closed: "${this.question}" got no votes.`;
    const top = Math.max(...r.map((x) => x.votes));
    const winners = r.filter((x) => x.votes === top).map((x) => x.option);
    const lead = winners.length > 1 ? `Tie between ${winners.join(' and ')}` : `${winners[0]} wins`;
    return `Poll closed: ${lead}. ${r.map((x) => `${x.option} ${x.percent}%`).join(', ')} (${total} votes).`;
  }
}

// --- Giveaways --------------------------------------------------------------------------------

export class Giveaway {
  private entrants = new Map<string, string>();
  open = true;

  constructor(readonly prize: string, readonly keyword = '!join') {}

  /** One entry per person. The streamer cannot enter their own giveaway. */
  handle(msg: ChatMessage): boolean {
    if (!this.open || msg.badges.broadcaster) return false;
    if (msg.text.trim().toLowerCase() !== this.keyword.toLowerCase()) return false;
    if (this.entrants.has(msg.userId)) return false;
    this.entrants.set(msg.userId, msg.displayName);
    return true;
  }

  get count(): number {
    return this.entrants.size;
  }

  /**
   * Closes entries and picks a winner. `random` returns [0, 1); pass crypto-backed randomness in
   * production so the draw cannot be predicted. Returns null when nobody entered.
   */
  draw(random: () => number): { userId: string; name: string } | null {
    this.open = false;
    const list = [...this.entrants.entries()];
    if (list.length === 0) return null;
    const i = Math.min(list.length - 1, Math.floor(random() * list.length));
    const [userId, name] = list[i]!;
    this.entrants.delete(userId); // a redraw picks someone else
    return { userId, name };
  }
}

/** Unpredictable randomness for real draws. */
export function fairRandom(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! / 2 ** 32;
}

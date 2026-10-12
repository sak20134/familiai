// Smart chat moderation. Decides what to do with each message; the Twitch client carries it out.
// Safety rule: the copilot escalates delete -> short timeout -> long timeout on its own,
// but it NEVER bans by itself. A ban is only ever suggested, for the streamer to confirm.

import { isStaff, type ChatMessage } from './types';

export interface ModRules {
  /** Words or phrases that get a message removed. Matched as whole words, case-insensitive. */
  blockedWords: string[];
  /** Remove links unless the sender is staff, a VIP, or (when allowed) a subscriber. */
  blockLinks: boolean;
  subscribersMayPostLinks: boolean;
  /** Shouting: share of letters in capitals, checked only on messages at least this long. */
  capsRatio: number;
  capsMinLength: number;
  /** The same message more than this many times inside the window counts as spam. */
  maxRepeats: number;
  repeatWindowMs: number;
  /** Strikes are forgiven after this long without trouble. */
  strikeMemoryMs: number;
}

export const DEFAULT_RULES: ModRules = {
  blockedWords: [],
  blockLinks: true,
  subscribersMayPostLinks: false,
  capsRatio: 0.7,
  capsMinLength: 12,
  maxRepeats: 3,
  repeatWindowMs: 30_000,
  strikeMemoryMs: 30 * 60_000,
};

export type ModAction =
  | { kind: 'allow' }
  | { kind: 'delete'; reason: string }
  | { kind: 'timeout'; seconds: number; reason: string }
  /** The ban itself is never automatic: they are held in a timeout while the streamer decides. */
  | { kind: 'suggest_ban'; holdSeconds: number; reason: string };

/** Undo common letter swaps, so "b4dw0rd" is caught like "badword". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[0@4]/g, (c) => (c === '0' ? 'o' : 'a'))
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't')
    .replace(/(.)\1{2,}/g, '$1$1'); // "baaaad" -> "baad"
}

const LINK = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(?:com|net|org|io|gg|tv|ly|xyz|ru|co|me|link|app|dev)\b(?:\/\S*)?/i;

export const hasLink = (text: string): boolean => LINK.test(text);

function shouting(text: string, rules: ModRules): boolean {
  if (text.length < rules.capsMinLength) return false;
  const letters = text.replace(/[^a-z]/gi, '');
  if (letters.length < rules.capsMinLength / 2) return false;
  const caps = letters.replace(/[^A-Z]/g, '').length;
  return caps / letters.length >= rules.capsRatio;
}

function blockedWord(text: string, words: readonly string[]): string | null {
  const plain = ` ${normalize(text).replace(/[^a-z0-9]+/g, ' ')} `;
  for (const w of words) {
    const want = normalize(w).replace(/[^a-z0-9]+/g, ' ').trim();
    if (want && plain.includes(` ${want} `)) return w;
  }
  return null;
}

/** How hard to come down on someone, by how many strikes they already have. */
const LADDER: ReadonlyArray<(reason: string) => ModAction> = [
  (reason) => ({ kind: 'delete', reason }),
  (reason) => ({ kind: 'timeout', seconds: 60, reason }),
  (reason) => ({ kind: 'timeout', seconds: 600, reason }),
];

export class Moderator {
  private strikes = new Map<string, { count: number; last: number }>();
  private recent = new Map<string, number[]>();

  constructor(public rules: ModRules = DEFAULT_RULES) {}

  review(msg: ChatMessage): ModAction {
    if (isStaff(msg.badges)) return { kind: 'allow' };
    const reason = this.problem(msg);
    if (!reason) return { kind: 'allow' };
    return this.punish(msg.userId, reason, msg.at);
  }

  /** How many strikes someone has right now (after forgiveness). */
  strikesFor(userId: string, now: number): number {
    const s = this.strikes.get(userId);
    if (!s || now - s.last > this.rules.strikeMemoryMs) return 0;
    return s.count;
  }

  /** Forget everything about a user (for example, after the streamer pardons them). */
  pardon(userId: string): void {
    this.strikes.delete(userId);
    this.recent.delete(userId);
  }

  private problem(msg: ChatMessage): string | null {
    const word = blockedWord(msg.text, this.rules.blockedWords);
    if (word) return 'blocked word';
    const linksOk = msg.badges.vip || (this.rules.subscribersMayPostLinks && msg.badges.subscriber);
    if (this.rules.blockLinks && !linksOk && hasLink(msg.text)) return 'links are not allowed';
    if (shouting(msg.text, this.rules)) return 'too many capitals';
    if (this.repeated(msg)) return 'repeating the same message';
    return null;
  }

  private repeated(msg: ChatMessage): boolean {
    const key = `${msg.userId}:${normalize(msg.text).trim()}`;
    const times = (this.recent.get(key) ?? []).filter((t) => msg.at - t < this.rules.repeatWindowMs);
    times.push(msg.at);
    this.recent.set(key, times);
    if (this.recent.size > 5000) this.recent.delete(this.recent.keys().next().value!); // bounded memory on long streams
    return times.length > this.rules.maxRepeats;
  }

  private punish(userId: string, reason: string, now: number): ModAction {
    const count = this.strikesFor(userId, now);
    this.strikes.set(userId, { count: count + 1, last: now });
    const step = LADDER[count];
    if (step) return step(reason);
    // Past the ladder: keep them quiet, and ask the streamer about a ban. Never ban on our own.
    return { kind: 'suggest_ban', holdSeconds: 600, reason: `${reason} (${count + 1} strikes)` };
  }
}

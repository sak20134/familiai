// After the stream: what happened, when chat went wild, and what moderation did.
// Highlights are minutes where chat ran at least twice its usual speed: the moments worth clipping.

import type { ChatMessage } from './types';

export interface ModEvent {
  at: number;
  userId: string;
  login: string;
  kind: 'delete' | 'timeout' | 'suggest_ban' | 'ban';
  reason: string;
}

export interface Highlight {
  at: number;
  /** Minutes into the stream. */
  minute: number;
  messagesPerMinute: number;
  /** The word chat kept saying, e.g. "pog" or "lol". */
  chatSaid: string | null;
}

export interface StreamSummary {
  durationMin: number;
  messages: number;
  chatters: number;
  firstTimeChatters: number;
  topChatters: Array<{ name: string; messages: number }>;
  highlights: Highlight[];
  moderation: { deleted: number; timeouts: number; banSuggestions: number; bans: number };
  text: string;
}

const COMMON = new Set(['the', 'and', 'you', 'that', 'this', 'for', 'are', 'was', 'with', 'have', 'its', 'not', 'but', 'what', 'just', 'like', 'can', 'all']);

function topWord(messages: readonly ChatMessage[]): string | null {
  const counts = new Map<string, number>();
  for (const m of messages) {
    // Count each word once per person, so one spammer cannot decide the highlight.
    for (const w of new Set(m.text.toLowerCase().match(/[a-z0-9]{2,20}/g) ?? [])) {
      if (!COMMON.has(w) && !w.startsWith('!')) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let n = 1;
  for (const [w, c] of counts) if (c > n) { best = w; n = c; }
  return best;
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export function summarize(log: readonly ChatMessage[], mods: readonly ModEvent[], startedAt: number, endedAt: number): StreamSummary {
  const durationMin = Math.max(1, Math.round((endedAt - startedAt) / 60_000));

  const perUser = new Map<string, { name: string; n: number }>();
  for (const m of log) {
    const u = perUser.get(m.userId) ?? { name: m.displayName, n: 0 };
    u.n++;
    perUser.set(m.userId, u);
  }
  const topChatters = [...perUser.values()].sort((a, b) => b.n - a.n).slice(0, 5).map((u) => ({ name: u.name, messages: u.n }));

  // Messages per minute, including the quiet minutes, so "usual speed" is honest.
  const buckets: ChatMessage[][] = Array.from({ length: durationMin }, () => []);
  for (const m of log) {
    const i = Math.floor((m.at - startedAt) / 60_000);
    if (i >= 0 && i < durationMin) buckets[i]!.push(m);
  }
  const rates = buckets.map((b) => b.length);
  const bar = Math.max(5, 2 * median(rates));
  const highlights: Highlight[] = [];
  for (let i = 0; i < buckets.length; i++) {
    if (rates[i]! < bar) continue;
    const prev = highlights[highlights.length - 1];
    if (prev && i - prev.minute <= 1) {
      // One moment that spans two minutes is still one highlight: keep the busier minute.
      if (rates[i]! > prev.messagesPerMinute) Object.assign(prev, { minute: i, at: startedAt + i * 60_000, messagesPerMinute: rates[i]!, chatSaid: topWord(buckets[i]!) });
      continue;
    }
    highlights.push({ at: startedAt + i * 60_000, minute: i, messagesPerMinute: rates[i]!, chatSaid: topWord(buckets[i]!) });
  }
  highlights.sort((a, b) => b.messagesPerMinute - a.messagesPerMinute);
  const top = highlights.slice(0, 5).sort((a, b) => a.minute - b.minute);

  const moderation = {
    deleted: mods.filter((e) => e.kind === 'delete').length,
    timeouts: mods.filter((e) => e.kind === 'timeout').length,
    banSuggestions: mods.filter((e) => e.kind === 'suggest_ban').length,
    bans: mods.filter((e) => e.kind === 'ban').length,
  };
  const firstTimeChatters = new Set(log.filter((m) => m.firstMessage).map((m) => m.userId)).size;

  const clock = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
  const lines = [
    `Streamed ${durationMin} min. ${log.length} chat messages from ${perUser.size} people${firstTimeChatters ? `, ${firstTimeChatters} chatting for the first time` : ''}.`,
    top.length
      ? `Highlights to clip: ${top.map((h) => `${clock(h.minute)} (${h.messagesPerMinute}/min${h.chatSaid ? `, chat said "${h.chatSaid}"` : ''})`).join('; ')}.`
      : 'No spikes in chat this time.',
    topChatters.length ? `Most active: ${topChatters.map((c) => `${c.name} (${c.messages})`).join(', ')}.` : '',
    moderation.deleted + moderation.timeouts + moderation.banSuggestions + moderation.bans > 0
      ? `Moderation: ${moderation.deleted} removed, ${moderation.timeouts} timeouts, ${moderation.banSuggestions} ban suggestions, ${moderation.bans} bans.`
      : 'Chat was clean: no moderation needed.',
  ].filter(Boolean);

  return { durationMin, messages: log.length, chatters: perUser.size, firstTimeChatters, topChatters, highlights: top, moderation, text: lines.join(' ') };
}

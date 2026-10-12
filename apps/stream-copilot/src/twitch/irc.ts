// Twitch chat arrives as IRC lines over a WebSocket. This turns a raw line into a ChatMessage.
// Format: @tag=value;tag=value :login!login@login.tmi.twitch.tv PRIVMSG #channel :text

import type { Badges, ChatMessage } from '../types';

/** Twitch escapes these characters inside tag values. */
function unescapeTag(v: string): string {
  return v.replace(/\\(.)/g, (_m, c: string) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' })[c] ?? c);
}

export function parseTags(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
  }
  return out;
}

export function parseBadges(raw: string | undefined): Badges {
  const names = new Set((raw ?? '').split(',').map((b) => b.split('/')[0]).filter(Boolean));
  return {
    broadcaster: names.has('broadcaster'),
    moderator: names.has('moderator'),
    vip: names.has('vip'),
    subscriber: names.has('subscriber') || names.has('founder'),
  };
}

export type IrcEvent =
  | { kind: 'message'; message: ChatMessage }
  | { kind: 'ping'; reply: string }
  | { kind: 'notice'; text: string }
  | { kind: 'other' };

export function parseLine(line: string, now = Date.now()): IrcEvent {
  const l = line.replace(/\r$/, '');
  if (l.startsWith('PING')) return { kind: 'ping', reply: `PONG${l.slice(4)}` };

  let rest = l;
  let tags: Record<string, string> = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return { kind: 'other' };
    tags = parseTags(rest.slice(1, sp));
    rest = rest.slice(sp + 1);
  }
  const notice = rest.match(/^:\S+ NOTICE \S+ :([\s\S]*)$/);
  if (notice) return { kind: 'notice', text: notice[1] ?? '' };

  const m = rest.match(/^:([^!\s]+)!\S+ PRIVMSG #\S+ :([\s\S]*)$/);
  if (!m) return { kind: 'other' };
  const login = m[1]!;
  let text = m[2] ?? '';
  // "/me waves" arrives wrapped in CTCP ACTION markers.
  const action = text.match(/^\u0001ACTION ([\s\S]*)\u0001$/);
  if (action) text = action[1]!;
  return {
    kind: 'message',
    message: {
      id: tags.id ?? '',
      userId: tags['user-id'] ?? login,
      login,
      displayName: tags['display-name'] || login,
      text,
      at: Number(tags['tmi-sent-ts']) || now,
      badges: parseBadges(tags.badges),
      firstMessage: tags['first-msg'] === '1',
    },
  };
}

/** One outgoing chat line, safe to send: no line breaks, within Twitch's 500-character limit. */
export function privmsg(channel: string, text: string): string {
  const clean = text.replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
  return `PRIVMSG #${channel.toLowerCase().replace(/^#/, '')} :${clean}`;
}

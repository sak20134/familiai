import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Copilot } from '../src/copilot';
import { Commands, Giveaway, Poll, Timers } from '../src/engagement';
import { Moderator, DEFAULT_RULES } from '../src/moderation';
import { matchName, ObsClient, type SocketLike } from '../src/obs/client';
import { authString } from '../src/obs/protocol';
import { summarize } from '../src/summary';
import { planCommand } from '../src/tools';
import type { ChatPlatform } from '../src/twitch/client';
import { parseLine, privmsg } from '../src/twitch/irc';
import type { Badges, ChatMessage } from '../src/types';

// --- fakes ----------------------------------------------------------------------------------

const NOBODY: Badges = { broadcaster: false, moderator: false, vip: false, subscriber: false };
let n = 0;
const chat = (login: string, text: string, at = 1_000_000, badges: Partial<Badges> = {}): ChatMessage => ({
  id: `m${++n}`, userId: `u-${login}`, login, displayName: login[0]!.toUpperCase() + login.slice(1), text, at, badges: { ...NOBODY, ...badges },
});

/** A pretend OBS that speaks the real obs-websocket v5 protocol, including the password check. */
function fakeObs(password: string | null, handler: (type: string, data: Record<string, unknown>) => { ok: boolean; data?: object; comment?: string }) {
  const sent: string[] = [];
  const factory = () => {
    const sock: SocketLike = {
      onopen: null, onmessage: null, onclose: null, onerror: null,
      close() { sock.onclose?.({ code: 1000 }); },
      send(raw: string) {
        sent.push(raw);
        const msg = JSON.parse(raw) as { op: number; d: Record<string, unknown> };
        const reply = (op: number, d: object) => queueMicrotask(() => sock.onmessage?.({ data: JSON.stringify({ op, d }) }));
        if (msg.op === 1) {
          if (password !== null && msg.d.authentication !== authString(password, 'SALT', 'CHALLENGE')) {
            queueMicrotask(() => sock.onclose?.({ code: 4009 }));
          } else reply(2, { negotiatedRpcVersion: 1 });
        } else if (msg.op === 6) {
          const r = handler(String(msg.d.requestType), (msg.d.requestData as Record<string, unknown>) ?? {});
          reply(7, { requestType: msg.d.requestType, requestId: msg.d.requestId, requestStatus: { result: r.ok, code: r.ok ? 100 : 600, comment: r.comment }, responseData: r.data });
        }
      },
    };
    queueMicrotask(() => sock.onmessage?.({ data: JSON.stringify({ op: 0, d: { rpcVersion: 1, ...(password !== null ? { authentication: { challenge: 'CHALLENGE', salt: 'SALT' } } : {}) } }) }));
    return sock;
  };
  return { factory, sent };
}

/** Records every moderation and chat action instead of calling Twitch. */
function fakeChat() {
  const calls: string[] = [];
  const platform: ChatPlatform = {
    say: async (t) => { calls.push(`say:${t}`); },
    deleteMessage: async (id) => { calls.push(`delete:${id}`); },
    timeout: async (u, s) => { calls.push(`timeout:${u}:${s}`); },
    ban: async (u) => { calls.push(`ban:${u}`); },
  };
  return { platform, calls };
}

const SCENES = { currentProgramSceneName: 'Gameplay', scenes: [{ sceneName: 'BRB' }, { sceneName: 'Gameplay' }, { sceneName: 'Starting Soon' }] };

// --- OBS ------------------------------------------------------------------------------------

describe('OBS control', () => {
  it('signs in exactly the way the obs-websocket spec says', () => {
    const b64 = (s: string) => createHash('sha256').update(s).digest('base64');
    expect(authString('pw', 'SALT', 'CHALLENGE')).toBe(b64(b64('pwSALT') + 'CHALLENGE'));
  });

  it('connects, lists scenes in display order, and switches only when OBS confirms', async () => {
    const switched: string[] = [];
    const { factory } = fakeObs('secret', (type, data) => {
      if (type === 'GetSceneList') return { ok: true, data: SCENES };
      if (type === 'SetCurrentProgramScene') { switched.push(String(data.sceneName)); return { ok: true }; }
      return { ok: false, comment: 'nope' };
    });
    const obs = new ObsClient(factory);
    await obs.connect('ws://x', 'secret');
    const s = await obs.scenes();
    expect(s.current).toBe('Gameplay');
    expect(s.scenes.map((x) => x.name)).toEqual(['Starting Soon', 'Gameplay', 'BRB']);
    await obs.switchScene('BRB');
    expect(switched).toEqual(['BRB']);
    await expect(obs.call('Unknown')).rejects.toThrow('nope');
  });

  it('explains a wrong or missing password in plain words', async () => {
    await expect(new ObsClient(fakeObs('secret', () => ({ ok: true })).factory).connect('ws://x', 'wrong')).rejects.toThrow('rejected the password');
    await expect(new ObsClient(fakeObs('secret', () => ({ ok: true })).factory).connect('ws://x')).rejects.toThrow('OBS_PASSWORD');
  });

  it('matches what the streamer says to the real scene name', () => {
    const names = ['Starting Soon', 'Gameplay', 'BRB', 'Mic/Aux', 'Desktop Audio'];
    expect(matchName('brb', names)).toBe('BRB');
    expect(matchName('starting', names)).toBe('Starting Soon');
    expect(matchName('mic', names)).toBe('Mic/Aux');
    expect(matchName('audio', ['Mic Audio', 'Desktop Audio'])).toBe(null); // ambiguous: ask, don't guess
  });
});

// --- Twitch chat ----------------------------------------------------------------------------

describe('Twitch chat', () => {
  it('reads a chat line with its badges and escaped name', () => {
    const ev = parseLine('@badges=moderator/1,subscriber/12;display-name=Cool\\sCat;first-msg=1;id=abc;tmi-sent-ts=1700000000000;user-id=42 :coolcat!coolcat@coolcat.tmi.twitch.tv PRIVMSG #chan :hello there');
    expect(ev.kind).toBe('message');
    if (ev.kind !== 'message') return;
    expect(ev.message).toMatchObject({ id: 'abc', userId: '42', login: 'coolcat', displayName: 'Cool Cat', text: 'hello there', at: 1700000000000, firstMessage: true });
    expect(ev.message.badges).toEqual({ broadcaster: false, moderator: true, vip: false, subscriber: true });
  });

  it('answers pings and reads /me actions', () => {
    expect(parseLine('PING :tmi.twitch.tv')).toEqual({ kind: 'ping', reply: 'PONG :tmi.twitch.tv' });
    const ev = parseLine(':bob!bob@bob.tmi.twitch.tv PRIVMSG #c :\u0001ACTION waves\u0001');
    expect(ev.kind === 'message' && ev.message.text).toBe('waves');
  });

  it('never sends a line break or an over-long message', () => {
    expect(privmsg('#Chan', 'one\r\ntwo')).toBe('PRIVMSG #chan :one two');
    expect(privmsg('c', 'x'.repeat(900)).length).toBe('PRIVMSG #c :'.length + 500);
  });
});

// --- Moderation -----------------------------------------------------------------------------

describe('moderation', () => {
  const rules = { ...DEFAULT_RULES, blockedWords: ['badword', 'ass'] };

  it('catches blocked words, even disguised, but only as whole words', () => {
    const mod = new Moderator(rules);
    expect(mod.review(chat('a', 'you are a b4dw0rd')).kind).toBe('delete');
    expect(mod.review(chat('b', 'I have class today')).kind).toBe('allow');
  });

  it('removes links and shouting from regular chatters, never from staff', () => {
    const mod = new Moderator(rules);
    expect(mod.review(chat('c', 'free stuff at scam.xyz')).kind).toBe('delete');
    expect(mod.review(chat('v', 'my clip www.example.com/x', 1, { vip: true })).kind).toBe('allow');
    expect(mod.review(chat('d', 'WHY IS NOBODY LISTENING TO ME')).kind).toBe('delete');
    expect(mod.review(chat('mod', 'BUY SCAM.XYZ BADWORD', 1, { moderator: true })).kind).toBe('allow');
  });

  it('catches the same message spammed, but not normal repetition', () => {
    const mod = new Moderator(rules);
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(mod.review(chat('e', 'follow me', t + i * 1000)).kind).toBe('allow');
    expect(mod.review(chat('e', 'follow me', t + 4000)).kind).toBe('delete');
    expect(mod.review(chat('f', 'gg', t)).kind).toBe('allow');
    expect(mod.review(chat('f', 'gg', t + 60_000)).kind).toBe('allow'); // outside the window
  });

  it('escalates delete, short timeout, long timeout, then only SUGGESTS a ban', () => {
    const mod = new Moderator(rules);
    const kinds = [0, 1, 2, 3].map((i) => mod.review(chat('g', 'badword', 1_000 + i)));
    expect(kinds.map((a) => a.kind)).toEqual(['delete', 'timeout', 'timeout', 'suggest_ban']);
    expect(kinds[1]).toMatchObject({ seconds: 60 });
    expect(kinds[2]).toMatchObject({ seconds: 600 });
    expect(kinds[3]).toMatchObject({ holdSeconds: 600 });
    expect(kinds.some((a) => (a.kind as string) === 'ban')).toBe(false);
  });

  it('forgives strikes after a quiet half hour', () => {
    const mod = new Moderator(rules);
    mod.review(chat('h', 'badword', 0));
    expect(mod.strikesFor('u-h', 1000)).toBe(1);
    expect(mod.review(chat('h', 'badword', 31 * 60_000)).kind).toBe('delete');
  });
});

// --- Engagement -----------------------------------------------------------------------------

describe('commands, timers, polls and giveaways', () => {
  it('runs commands with cooldowns; staff skip the cooldown; staff-only stays hidden', () => {
    const c = new Commands();
    c.set('!discord', 'Join us, {user}: discord.gg/example');
    c.set('secret', 'mods only', { staffOnly: true });
    expect(c.handle(chat('amy', '!discord', 0))).toBe('Join us, Amy: discord.gg/example');
    expect(c.handle(chat('ben', '!discord', 5_000))).toBe(null);
    expect(c.handle(chat('mo', '!discord', 6_000, { moderator: true }))).toContain('Mo');
    expect(c.handle(chat('amy', '!secret'))).toBe(null);
    expect(c.handle(chat('amy', '!commands'))).toBe('Commands: !discord');
    expect(() => c.set('bad name!', 'x')).toThrow();
  });

  it('skips timed messages while chat is dead', () => {
    const t = new Timers();
    t.add({ id: 'socials', text: 'Follow!', everyMs: 600_000, minChatLines: 5 }, 0);
    expect(t.due(700_000)).toEqual([]);
    for (let i = 0; i < 5; i++) t.sawChat();
    expect(t.due(700_000)).toEqual(['Follow!']);
    expect(t.due(800_000)).toEqual([]);
  });

  it('counts one vote per person and reports ties honestly', () => {
    const p = new Poll('Best snack?', ['Chips', 'Popcorn']);
    expect(p.handle(chat('a', '!vote 1'))).toBe(true);
    p.handle(chat('a', '!vote 2'));
    p.handle(chat('b', '!vote 1'));
    expect(p.handle(chat('c', '!vote 9'))).toBe(false);
    expect(p.results().map((r) => r.votes)).toEqual([1, 1]);
    expect(p.close()).toContain('Tie between Chips and Popcorn');
    expect(p.handle(chat('d', '!vote 1'))).toBe(false); // closed
  });

  it('gives one entry each, keeps the streamer out, and redraws someone new', () => {
    const g = new Giveaway('a game key');
    expect(g.handle(chat('a', '!join'))).toBe(true);
    expect(g.handle(chat('a', '!join'))).toBe(false);
    expect(g.handle(chat('me', '!join', 1, { broadcaster: true }))).toBe(false);
    g.handle(chat('b', '!join'));
    const first = g.draw(() => 0);
    const second = g.draw(() => 0);
    expect(first?.name).toBe('A');
    expect(second?.name).toBe('B');
    expect(g.draw(() => 0)).toBe(null);
  });
});

// --- Planner --------------------------------------------------------------------------------

describe('understanding the streamer', () => {
  it('turns everyday phrasing into actions', () => {
    expect(planCommand('switch to BRB')).toEqual({ tool: 'obs_switch_scene', args: { scene: 'BRB' } });
    expect(planCommand('brb')).toEqual({ tool: 'obs_switch_scene', args: { scene: 'brb' } });
    expect(planCommand('Hey Nova, mute my mic')).toEqual({ tool: 'obs_mute', args: { input: 'mic', muted: true } });
    expect(planCommand('timeout @spammer 5 minutes')).toMatchObject({ tool: 'chat_timeout', args: { user: 'spammer', seconds: 300 } });
    expect(planCommand('timeout bob')).toMatchObject({ args: { seconds: 600 } });
    expect(planCommand('ban troll for racism')).toEqual({ tool: 'chat_ban', args: { user: 'troll', reason: 'racism' } });
    expect(planCommand('start a poll: best snack? chips or popcorn or nachos')).toEqual({ tool: 'poll_start', args: { question: 'best snack', options: ['chips', 'popcorn', 'nachos'] } });
    expect(planCommand('end stream')).toEqual({ tool: 'obs_stop_stream', args: {} });
    expect(planCommand('add command !discord that says join us')).toEqual({ tool: 'command_set', args: { name: 'discord', reply: 'join us' } });
    expect(planCommand('make me a sandwich')).toBe(null);
  });
});

// --- The copilot as a whole -----------------------------------------------------------------

describe('copilot', () => {
  const obsFor = (scenes = SCENES) => ({
    scenes: async () => ({ current: scenes.currentProgramSceneName, scenes: [...scenes.scenes].reverse().map((s) => ({ name: s.sceneName })) }),
    switched: [] as string[],
    switchScene: async function (this: { switched: string[] }, name: string) { this.switched.push(name); },
    inputs: async () => ['Mic/Aux', 'Desktop Audio'],
    setMute: async () => {},
    startStream: async () => {},
    stopStream: async () => {},
  });

  it('removes a bad message and runs no command for it', async () => {
    const { platform, calls } = fakeChat();
    const c = new Copilot({ chat: platform, moderator: new Moderator({ ...DEFAULT_RULES, blockedWords: ['badword'] }) });
    c.commands.set('hi', 'hello {user}');
    await c.onChat(chat('x', '!hi badword'));
    expect(calls).toEqual([expect.stringMatching(/^delete:/)]);
    await c.onChat(chat('y', '!hi'));
    expect(calls).toContain('say:hello Y');
  });

  it('switches scenes by spoken name and is honest when a scene does not exist', async () => {
    const obs = obsFor();
    const c = new Copilot({ obs });
    expect(await c.run('go to brb')).toEqual({ kind: 'done', text: 'Switched to BRB.' });
    expect(obs.switched).toEqual(['BRB']);
    const missing = await c.run('switch to space station');
    expect(missing.kind).toBe('failed');
    expect(missing.kind === 'failed' && missing.text).toContain('Your scenes: Starting Soon, Gameplay, BRB');
    expect(await new Copilot().run('go to brb')).toMatchObject({ kind: 'failed', text: expect.stringContaining('OBS is not connected') });
  });

  it('always asks before a ban, and a request can only be used once', async () => {
    const { platform, calls } = fakeChat();
    const c = new Copilot({ chat: platform, autopilot: true });
    await c.onChat(chat('troll', 'hello'));
    const asked = await c.run('ban troll');
    expect(asked.kind).toBe('needs_approval');
    expect(calls.some((x) => x.startsWith('ban:'))).toBe(false);
    if (asked.kind !== 'needs_approval') return;
    expect(await c.approve(asked.id)).toEqual({ kind: 'done', text: 'Troll is banned.' });
    expect(calls).toContain('ban:u-troll');
    expect((await c.approve(asked.id)).kind).toBe('failed');
  });

  it('asks before a timeout unless Autopilot is on', async () => {
    const { platform, calls } = fakeChat();
    const c = new Copilot({ chat: platform });
    await c.onChat(chat('loud', 'hi'));
    expect((await c.run('timeout loud 1 minute')).kind).toBe('needs_approval');
    c.autopilot = true;
    expect(await c.run('timeout loud 1 minute')).toEqual({ kind: 'done', text: 'Loud is timed out for 1 minute.' });
    expect(calls).toContain('timeout:u-loud:60');
  });

  it('holds a repeat offender in a timeout and asks the streamer about a ban', async () => {
    const { platform, calls } = fakeChat();
    const told: string[] = [];
    const c = new Copilot({ chat: platform, moderator: new Moderator({ ...DEFAULT_RULES, blockedWords: ['badword'] }), notify: (t) => told.push(t) });
    for (let i = 0; i < 4; i++) await c.onChat(chat('repeat', 'badword', 1_000 + i));
    expect(calls).toContain('timeout:u-repeat:600');
    expect(calls.some((x) => x.startsWith('ban:'))).toBe(false);
    expect(told[0]).toContain('Ban them?');
    expect(c.pendingApprovals()).toHaveLength(1);
  });

  it('refuses to act on someone it has never seen in chat', async () => {
    const c = new Copilot({ chat: fakeChat().platform, autopilot: true });
    const out = await c.run('timeout ghost 5 minutes');
    expect(out.kind === 'failed' && out.text).toContain(`haven't seen "ghost"`);
  });

  it('runs a giveaway end to end from chat', async () => {
    const { platform, calls } = fakeChat();
    const c = new Copilot({ chat: platform, autopilot: true, random: () => 0 });
    await c.run('start a giveaway for a game key');
    await c.onChat(chat('ann', '!join'));
    await c.onChat(chat('bob', '!join'));
    const out = await c.run('draw winner');
    expect(out).toEqual({ kind: 'done', text: 'Ann won, out of 2 entries.' });
    expect(calls).toContain('say:Ann wins a game key! Congratulations!');
  });
});

describe('stream summary', () => {
  it('finds the minute chat exploded and what chat was saying', () => {
    const start = 0;
    const log: ChatMessage[] = [];
    for (let min = 0; min < 10; min++) for (let i = 0; i < 2; i++) log.push(chat(`u${i}`, 'hi', min * 60_000 + i));
    for (let i = 0; i < 20; i++) log.push(chat(`fan${i}`, 'POG that was insane', 6 * 60_000 + i, i === 0 ? {} : {}));
    const s = summarize(log, [{ at: 1, userId: 'x', login: 'x', kind: 'delete', reason: 'r' }], start, 10 * 60_000);
    expect(s.highlights).toHaveLength(1);
    expect(s.highlights[0]).toMatchObject({ minute: 6, chatSaid: 'pog' });
    expect(s.text).toContain('Highlights to clip: 0:06');
    expect(s.text).toContain('1 removed');
    expect(s.chatters).toBe(22);
  });
});

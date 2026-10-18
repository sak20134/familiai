// The copilot: watches chat, keeps it clean and lively, and does what the streamer asks.
// Everything risky goes through the same approval rules as Family AI, and every reply is
// honest about what actually happened: done, waiting for your OK, or failed and why.

import { needsApproval, type Autonomy } from '@familiai/core';
import { Commands, fairRandom, Giveaway, Poll, Timers } from './engagement';
import { Moderator, type ModAction } from './moderation';
import { matchName, type ObsClient } from './obs/client';
import { summarize, type ModEvent, type StreamSummary } from './summary';
import { planCommand, TOOLS, type Plan } from './tools';
import type { ChatPlatform } from './twitch/client';
import type { ChatMessage } from './types';

export type Outcome =
  | { kind: 'done'; text: string }
  | { kind: 'needs_approval'; id: string; summary: string }
  | { kind: 'failed'; text: string };

interface Pending {
  id: string;
  plan: Plan;
  summary: string;
  createdAt: number;
}

export interface CopilotOptions {
  obs?: Pick<ObsClient, 'scenes' | 'switchScene' | 'inputs' | 'setMute' | 'startStream' | 'stopStream'>;
  chat?: ChatPlatform;
  moderator?: Moderator;
  /** Autopilot: medium-risk actions (timeouts, going live) run without asking. High risk always asks. */
  autopilot?: boolean;
  now?: () => number;
  random?: () => number;
  /** Things the streamer should hear about: ban suggestions, failures, results. */
  notify?: (text: string) => void;
}

const APPROVAL_TTL_MS = 10 * 60_000;
const MAX_LOG = 50_000;

export class Copilot {
  readonly moderator: Moderator;
  readonly commands = new Commands();
  readonly timers = new Timers();
  poll: Poll | null = null;
  giveaway: Giveaway | null = null;
  autopilot: boolean;

  private log: ChatMessage[] = [];
  private mods: ModEvent[] = [];
  private seen = new Map<string, { userId: string; name: string }>();
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private obs: CopilotOptions['obs'];
  private chat: ChatPlatform | undefined;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly notify: (text: string) => void;

  constructor(opts: CopilotOptions = {}) {
    this.obs = opts.obs;
    this.chat = opts.chat;
    this.moderator = opts.moderator ?? new Moderator();
    this.autopilot = opts.autopilot ?? false;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? fairRandom;
    this.notify = opts.notify ?? (() => {});
    this.startedAt = this.now();
  }

  /** Plug in OBS or chat once they connect. */
  attach(parts: Pick<CopilotOptions, 'obs' | 'chat'>): void {
    if (parts.obs) this.obs = parts.obs;
    if (parts.chat) this.chat = parts.chat;
  }

  // --- Chat ----------------------------------------------------------------------------------

  /** Handle one incoming chat message. Moderation runs first; a removed message triggers nothing else. */
  async onChat(msg: ChatMessage): Promise<ModAction> {
    this.log.push(msg);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    this.seen.set(msg.login.toLowerCase(), { userId: msg.userId, name: msg.displayName });
    this.timers.sawChat();

    const action = this.moderator.review(msg);
    if (action.kind !== 'allow') {
      await this.enforce(msg, action);
      return action;
    }

    this.poll?.handle(msg);
    this.giveaway?.handle(msg);
    const reply = this.commands.handle(msg);
    if (reply) await this.say(reply);
    return action;
  }

  private async enforce(msg: ChatMessage, action: Exclude<ModAction, { kind: 'allow' }>): Promise<void> {
    const chat = this.chat;
    const event = (kind: ModEvent['kind']) => this.mods.push({ at: msg.at, userId: msg.userId, login: msg.login, kind, reason: action.reason });
    try {
      if (action.kind === 'delete') {
        await chat?.deleteMessage(msg.id);
        event('delete');
      } else if (action.kind === 'timeout') {
        await chat?.timeout(msg.userId, action.seconds, action.reason);
        event('timeout');
      } else {
        // Keep them quiet now; the ban itself waits for the streamer.
        await chat?.timeout(msg.userId, action.holdSeconds, action.reason);
        event('suggest_ban');
        const out = this.ask({ tool: 'chat_ban', args: { user: msg.login, reason: action.reason } });
        if (out.kind === 'needs_approval') this.notify(`${msg.displayName} keeps breaking the rules (${action.reason}). They're timed out. Ban them? Request ${out.id}.`);
      }
    } catch (err) {
      this.notify(`Moderation failed for ${msg.displayName}: ${(err as Error).message}`);
    }
  }

  // --- Streamer commands -----------------------------------------------------------------------

  /** What the streamer says or types: "go to BRB", "mute mic", "timeout bob 5 minutes". */
  async run(text: string): Promise<Outcome> {
    const plan = planCommand(text);
    if (!plan) return { kind: 'failed', text: `I didn't catch that. Try "switch to BRB", "mute mic", "timeout name 5 minutes" or "start a poll".` };
    return this.act(plan);
  }

  /** Runs a planned action, unless its risk means the streamer must OK it first. */
  async act(plan: Plan): Promise<Outcome> {
    const out = this.ask(plan);
    return out.kind === 'needs_approval' ? out : this.execute(plan);
  }

  private ask(plan: Plan): Outcome | { kind: 'clear' } {
    const autonomy: Autonomy = { aiMode: this.autopilot, standing: new Set() };
    if (!needsApproval(TOOLS[plan.tool], autonomy)) return { kind: 'clear' };
    const id = `req${this.nextId++}`;
    const summary = describe(plan);
    this.pending.set(id, { id, plan, summary, createdAt: this.now() });
    return { kind: 'needs_approval', id, summary };
  }

  pendingApprovals(): Array<{ id: string; summary: string }> {
    this.expire();
    return [...this.pending.values()].map((p) => ({ id: p.id, summary: p.summary }));
  }

  async approve(id: string): Promise<Outcome> {
    this.expire();
    const p = this.pending.get(id);
    if (!p) return { kind: 'failed', text: 'That request is gone: it was already decided or it expired.' };
    this.pending.delete(id); // claimed before running, so a double tap cannot run it twice
    return this.execute(p.plan);
  }

  reject(id: string): Outcome {
    const p = this.pending.get(id);
    if (!p) return { kind: 'failed', text: 'That request is gone: it was already decided or it expired.' };
    this.pending.delete(id);
    return { kind: 'done', text: `Okay, not doing it: ${p.summary}.` };
  }

  /**
   * Runs a plan the caller has ALREADY cleared through its own approval gate (the desktop bot
   * uses one gate for every tool). Never call this with something the user has not okayed.
   */
  async runApproved(plan: Plan): Promise<Outcome> {
    return this.execute(plan);
  }

  private expire(): void {
    const now = this.now();
    for (const [id, p] of this.pending) if (now - p.createdAt > APPROVAL_TTL_MS) this.pending.delete(id);
  }

  private async execute(plan: Plan): Promise<Outcome> {
    const a = plan.args;
    try {
      switch (plan.tool) {
        case 'obs_switch_scene': {
          const obs = this.needObs();
          const { scenes, current } = await obs.scenes();
          const name = matchName(String(a.scene), scenes.map((s) => s.name));
          if (!name) return { kind: 'failed', text: `There's no scene like "${a.scene}". Your scenes: ${scenes.map((s) => s.name).join(', ')}.` };
          if (name === current) return { kind: 'done', text: `Already on ${name}.` };
          await obs.switchScene(name);
          return { kind: 'done', text: `Switched to ${name}.` };
        }
        case 'obs_mute': {
          const obs = this.needObs();
          const inputs = await obs.inputs();
          const name = matchName(String(a.input), inputs);
          if (!name) return { kind: 'failed', text: `There's no audio source like "${a.input}". You have: ${inputs.join(', ')}.` };
          await obs.setMute(name, Boolean(a.muted));
          return { kind: 'done', text: `${name} ${a.muted ? 'muted' : 'unmuted'}.` };
        }
        case 'obs_start_stream':
          await this.needObs().startStream();
          return { kind: 'done', text: "You're live." };
        case 'obs_stop_stream':
          await this.needObs().stopStream();
          return { kind: 'done', text: `Stream ended. ${this.summary().text}` };
        case 'chat_say':
          await this.say(String(a.text));
          return { kind: 'done', text: 'Posted in chat.' };
        case 'chat_timeout': {
          const who = this.who(String(a.user));
          await this.needChat().timeout(who.userId, Number(a.seconds), String(a.reason));
          this.mods.push({ at: this.now(), userId: who.userId, login: String(a.user), kind: 'timeout', reason: String(a.reason) });
          return { kind: 'done', text: `${who.name} is timed out for ${formatDuration(Number(a.seconds))}.` };
        }
        case 'chat_ban': {
          const who = this.who(String(a.user));
          await this.needChat().ban(who.userId, String(a.reason));
          this.mods.push({ at: this.now(), userId: who.userId, login: String(a.user), kind: 'ban', reason: String(a.reason) });
          return { kind: 'done', text: `${who.name} is banned.` };
        }
        case 'chat_pardon': {
          const who = this.who(String(a.user));
          this.moderator.pardon(who.userId);
          return { kind: 'done', text: `${who.name}'s strikes are cleared.` };
        }
        case 'command_set': {
          const def = this.commands.set(String(a.name), String(a.reply));
          return { kind: 'done', text: `!${def.name} is ready.` };
        }
        case 'poll_start': {
          if (this.poll?.open) return { kind: 'failed', text: `A poll is already running: "${this.poll.question}". Close it first.` };
          this.poll = new Poll(String(a.question), a.options as string[]);
          await this.say(this.poll.announce());
          return { kind: 'done', text: 'Poll started.' };
        }
        case 'poll_end': {
          if (!this.poll?.open) return { kind: 'failed', text: 'No poll is running.' };
          const result = this.poll.close();
          await this.say(result);
          return { kind: 'done', text: result };
        }
        case 'giveaway_start': {
          if (this.giveaway?.open) return { kind: 'failed', text: `A giveaway for ${this.giveaway.prize} is already open.` };
          this.giveaway = new Giveaway(String(a.prize));
          await this.say(`Giveaway for ${this.giveaway.prize}! Type ${this.giveaway.keyword} to enter.`);
          return { kind: 'done', text: 'Giveaway open.' };
        }
        case 'giveaway_draw': {
          if (!this.giveaway) return { kind: 'failed', text: 'No giveaway to draw.' };
          const entrants = this.giveaway.count;
          const winner = this.giveaway.draw(this.random);
          if (!winner) return { kind: 'failed', text: 'Nobody entered the giveaway.' };
          await this.say(`${winner.name} wins ${this.giveaway.prize}! Congratulations!`);
          return { kind: 'done', text: `${winner.name} won, out of ${entrants} entr${entrants === 1 ? 'y' : 'ies'}.` };
        }
        case 'summary':
          return { kind: 'done', text: this.summary().text };
      }
    } catch (err) {
      return { kind: 'failed', text: (err as Error).message };
    }
  }

  // --- Timers and summary ----------------------------------------------------------------------

  /** Call about once a minute: posts timed messages that are due. */
  async tick(): Promise<void> {
    this.expire();
    for (const text of this.timers.due(this.now())) await this.say(text);
  }

  summary(): StreamSummary {
    return summarize(this.log, this.mods, this.startedAt, this.now());
  }

  // --- helpers ---------------------------------------------------------------------------------

  private async say(text: string): Promise<void> {
    await this.chat?.say(text);
  }

  private needObs() {
    if (!this.obs) throw new Error('OBS is not connected. Open OBS and turn on its WebSocket server.');
    return this.obs;
  }

  private needChat() {
    if (!this.chat) throw new Error('Twitch chat is not connected.');
    return this.chat;
  }

  /** Twitch moderation needs the user's id, which we only know from seeing them in chat. */
  private who(login: string): { userId: string; name: string } {
    const found = this.seen.get(login.toLowerCase().replace(/^@/, ''));
    if (!found) throw new Error(`I haven't seen "${login}" in chat this stream, so I can't find them.`);
    return found;
  }
}

function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

function describe(plan: Plan): string {
  const a = plan.args;
  switch (plan.tool) {
    case 'chat_ban': return `BAN ${a.user} permanently (${a.reason})`;
    case 'chat_timeout': return `Time out ${a.user} for ${formatDuration(Number(a.seconds))}`;
    case 'obs_stop_stream': return 'END the stream';
    case 'obs_start_stream': return 'Go live';
    case 'giveaway_draw': return 'Draw the giveaway winner';
    default: return TOOLS[plan.tool].description;
  }
}

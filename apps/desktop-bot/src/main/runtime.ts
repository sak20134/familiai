// Puts the bot together: one gate, one agent, all the tools, the stream copilot, the family,
// the screen-time watcher and the phone/terminal server. No Electron here, so it is testable;
// main.ts passes in the few things only Electron can do.

import { can } from '@familiai/core';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { ActivityLog } from './agent/activity';
import { createApiEngine } from './agent/api-brain';
import { Brain, brainById, type Engine } from './agent/brain';
import { Agent } from './agent/agent';
import { canApprove, Gate } from './agent/gate';
import { MemoryStore } from './agent/memory';
import type { ModelConfig } from './agent/model';
import { PLANNERS } from './agent/planners';
import type { Actor, Outcome, Reply } from './agent/types';
import { ConfigStore, type Cipher } from './config';
import { closeApp, listProcesses, normalizeName, type System } from './desktop/apps';
import { TakeOver } from './desktop/takeover';
import { desktopTools } from './desktop/tools';
import { Family } from './family/family';
import { ScreenTime } from './family/screentime';
import { familyTools } from './family/tools';
import { RemoteServer, visibleActivity } from './remote/server';
import { StreamHub } from './stream/stream';

export interface RuntimeDeps {
  dataDir: string;
  ownerName: string;
  cipher: Cipher;
  botName: () => string;
  openExternal: (url: string) => Promise<void>;
  releaseFocus: () => Promise<void>;
  /** Something the bot should say out loud or in its bubble. */
  say: (text: string) => void;
  /** The state changed; the window should refresh. */
  changed: () => void;
  phonePage: () => string;
  quit: () => void;
  sys?: System;
  env?: NodeJS.ProcessEnv;
  /** Tests pass their own brain; the app makes the real one. */
  brain?: Brain;
  /** Tests pass their own network call for the API brain. */
  apiFetch?: typeof fetch;
}

/** Tools the user already OK'd by approving take-over: they run without a new OK while it lasts. */
const TAKEOVER_TOOLS = ['type_text', 'press_keys', 'open_app', 'close_app'];
const SCREEN_TICK_MS = 30_000;

export function realSystem(): System {
  return {
    platform: process.platform,
    exec: (file, args, env) => new Promise((resolve, reject) => {
      execFile(file, [...args], { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env }, (err, stdout) => {
        if (err) reject(err);
        else resolve({ stdout: String(stdout) });
      });
    }),
    async kill(pid, force) {
      if (process.platform === 'win32') {
        await this.exec('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])]).catch(() => undefined);
      } else {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    selfPids: [process.pid, process.ppid],
    selfName: normalizeName(process.execPath),
  };
}

export class Runtime {
  readonly config: ConfigStore;
  readonly family: Family;
  readonly gate = new Gate();
  readonly log: ActivityLog;
  readonly memory: MemoryStore;
  readonly screen: ScreenTime;
  readonly stream: StreamHub;
  readonly takeover: TakeOver;
  readonly agent: Agent;
  readonly remote: RemoteServer;
  readonly sys: System;
  readonly brain: Brain;
  private announced = false;
  private started = false;
  private api: { key: string; engine: Engine } | null = null;
  private phoneError: string | null = null;
  private screenTimer: ReturnType<typeof setInterval> | null = null;
  private lastScreenTick = Date.now();
  private enforcing = new Map<string, number>();
  private readonly cliFile: string;
  private readonly env: NodeJS.ProcessEnv;
  /** Proves a terminal command comes from someone logged in on this computer. New every start. */
  private readonly controlToken = randomBytes(32).toString('base64url');

  constructor(private readonly d: RuntimeDeps) {
    this.env = d.env ?? process.env;
    this.sys = d.sys ?? realSystem();
    this.config = new ConfigStore(d.dataDir, d.cipher);
    let lastReport = '';
    this.brain = d.brain ?? new Brain({
      dir: join(d.dataDir, 'models'),
      onStatus: (s) => {
        // Said once per run: the brain may nap and wake many times.
        if (s.state === 'ready' && !this.announced) { this.announced = true; d.say('My brain is awake. Ask me anything!'); }
        if (s.state === 'error') this.log.add('safety', 'failed', 'Bot', `Brain: ${s.detail}`);
        // Refresh the window at most once per percent while downloading.
        const key = `${s.state}:${Math.floor((s.progress ?? 0) * 100)}`;
        if (key !== lastReport) { lastReport = key; d.changed(); }
      },
    });
    this.family = new Family(join(d.dataDir, 'family.json'), d.ownerName);
    this.log = new ActivityLog(join(d.dataDir, 'activity.jsonl'));
    this.memory = new MemoryStore(join(d.dataDir, 'memory.json'));
    this.screen = new ScreenTime(join(d.dataDir, 'screentime.json'));
    this.stream = new StreamHub(this.log, (t) => d.say(t));
    this.takeover = new TakeOver({
      platform: this.sys.platform,
      exec: this.sys.exec,
      releaseFocus: d.releaseFocus,
      onChange: (s) => {
        for (const t of TAKEOVER_TOOLS) if (s.active) this.gate.standing.add(t); else this.gate.standing.delete(t);
        this.log.add('safety', 'info', s.by || 'Bot', s.active ? 'Take-over started.' : 'Take-over ended.');
        d.changed();
      },
    });
    this.agent = new Agent({
      tools: [
        ...desktopTools({ sys: this.sys, takeover: this.takeover, openExternal: d.openExternal }),
        ...familyTools({ screen: this.screen, memory: this.memory, sys: this.sys }),
        ...this.stream.tools(),
      ],
      planners: PLANNERS,
      gate: this.gate,
      log: this.log,
      memory: this.memory,
      model: () => this.modelConfig(),
      botName: d.botName,
      external: this.stream.external(),
      onStop: () => this.takeover.stop(),
      status: () => this.statusLines(),
      // A small brain chooses better from fewer tools: stream tools only while a stream is set up.
      toolFilter: (t) => !t.spec.name.startsWith('stream_') || this.streamActive(),
    });
    this.cliFile = join(d.dataDir, 'cli.json');
    this.remote = new RemoteServer({
      bot: {
        family: this.family,
        handle: (t, a) => this.handle(t, a),
        approve: (id, a) => this.approve(id, a),
        reject: (id, a) => this.reject(id, a),
        stop: (a) => this.stop(a),
        state: (a) => this.state(a),
        quit: d.quit,
      },
      controlToken: this.controlToken,
      phonePage: d.phonePage,
    });
  }

  /** The person sitting at the computer is the owner. */
  localActor(): Actor {
    return this.family.actor(this.family.owner(), 'desktop');
  }

  async start(): Promise<void> {
    const cfg = this.config.get();
    try {
      const port = await this.remote.startControl(cfg.controlPort);
      writeFileSync(this.cliFile, JSON.stringify({ port, token: this.controlToken, pid: process.pid }), { mode: 0o600 });
    } catch (err) {
      this.log.add('safety', 'failed', 'Bot', `The terminal command channel could not start: ${(err as Error).message}`);
    }
    await this.applyBrain();
    this.started = true;
    if (this.localBrain()) this.brain.prepare(); // downloads it if missing; it wakes on the first question
    if (cfg.phoneControl) await this.setPhoneControl(true);
    if (cfg.autoConnectStream) void this.connectStream();
    this.screenTimer = setInterval(() => void this.screenTick(), SCREEN_TICK_MS);
    this.screenTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    if (this.screenTimer) clearInterval(this.screenTimer);
    this.takeover.stop();
    this.stream.disconnect();
    await this.remote.close();
    await this.brain.close().catch(() => undefined);
    try {
      const saved = existsSync(this.cliFile) ? (JSON.parse(readFileSync(this.cliFile, 'utf8')) as { pid?: number }) : {};
      if (saved.pid === process.pid) rmSync(this.cliFile, { force: true });
    } catch {
      // nothing to clean up
    }
  }

  private localBrain(): boolean {
    const c = this.config.get().brain;
    return c === 'default' || c === 'light';
  }

  /** Called at start and whenever the brain setting changes. */
  async applyBrain(): Promise<void> {
    const c = this.config.get();
    if (c.brain === 'default' || c.brain === 'light') {
      await this.brain.select(brainById(c.brain));
      if (this.started) this.brain.prepare();
    } else {
      await this.brain.close().catch(() => undefined); // not needed now: free the memory
    }
    this.d.changed();
  }

  /** The brain that answers, as chosen in Settings. null means fixed commands only. */
  modelConfig(): ModelConfig | null {
    const c = this.config.get();
    if (c.brain === 'off') return null;
    if (c.brain === 'api') return { engine: async () => this.apiEngine() };
    return { brain: this.brain };
  }

  private apiEngine(): Engine {
    const c = this.config.get();
    const key = this.config.secret('apiKey') ?? '';
    const id = JSON.stringify([c.apiUrl, c.apiModel, key]);
    if (this.api?.key !== id) {
      this.api = { key: id, engine: createApiEngine({ baseUrl: c.apiUrl, model: c.apiModel, apiKey: key, ...(this.d.apiFetch ? { fetchImpl: this.d.apiFetch } : {}) }) };
    }
    return this.api.engine;
  }

  private brainView(): { modelReady: boolean; brain: { state: 'missing' | 'downloading' | 'asleep' | 'loading' | 'ready' | 'error'; detail: string; progress?: number } } {
    const c = this.config.get();
    if (c.brain === 'off') return { modelReady: false, brain: { state: 'asleep', detail: 'AI is off (light mode). Fixed commands only.' } };
    if (c.brain === 'api') {
      const ready = Boolean(c.apiUrl && c.apiModel && (this.config.secret('apiKey') || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(c.apiUrl)));
      return { modelReady: ready, brain: ready ? { state: 'ready', detail: 'Using your own API. What you say is sent to it.' } : { state: 'missing', detail: 'Fill in your API address, model and key in Settings.' } };
    }
    return { modelReady: this.brain.downloaded, brain: this.brain.status() };
  }

  async handle(text: string, actor: Actor): Promise<Reply> {
    try {
      return await this.agent.handle(text, actor);
    } finally {
      this.d.changed();
    }
  }

  async approve(id: string, actor: Actor): Promise<Outcome> {
    const out = await this.agent.approve(id, actor);
    this.d.changed();
    return out;
  }

  reject(id: string, actor: Actor): Outcome {
    const out = this.agent.reject(id, actor);
    this.d.changed();
    return out;
  }

  stop(actor: Actor): void {
    this.gate.stop(actor);
    this.takeover.stop();
    this.log.add('safety', 'done', actor.name, 'Pulled the stop switch: everything stopped, waiting requests cleared.');
    this.d.say('Stopped. Nothing will run until you say "resume".');
    this.d.changed();
  }

  async connectStream(): Promise<void> {
    const c = this.config.get();
    await this.stream.connectObs(c.obsUrl, this.config.secret('obsPassword') ?? this.env.OBS_PASSWORD);
    const token = this.config.secret('twitchToken') ?? this.env.TWITCH_TOKEN ?? '';
    const clientId = c.twitchClientId || this.env.TWITCH_CLIENT_ID || '';
    const channel = c.twitchChannel || this.env.TWITCH_CHANNEL || '';
    if (token || clientId || channel) await this.stream.connectTwitch(clientId, token, channel);
    this.d.changed();
  }

  async setPhoneControl(on: boolean): Promise<void> {
    this.phoneError = null;
    if (!on) {
      await this.remote.stopPhone();
      this.family.cancelPairing();
      return;
    }
    try {
      await this.remote.startPhone(this.config.get().phonePort);
      this.log.add('safety', 'info', 'Bot', 'Phone control is on (home Wi-Fi only).');
    } catch (err) {
      this.phoneError = (err as Error).message;
    }
  }

  phoneUrls(): string[] {
    if (!this.remote.phoneRunning()) return [];
    const port = this.config.get().phonePort;
    const out: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
    }
    return out;
  }

  /** One state shape for the bot window, the phone and the terminal, cut to what this person may see. */
  state(actor: Actor): Record<string, unknown> & { pending: unknown[] } {
    const isParent = actor.role === 'owner' || actor.role === 'admin';
    return {
      botName: this.d.botName(),
      you: { name: actor.name, role: actor.role },
      canApprove: canApprove(actor, 'high'),
      canManage: isParent,
      ...this.brainView(),
      aiMode: this.gate.aiMode,
      stopped: this.gate.stopped,
      takeover: this.takeover.state(),
      pending: this.agent.pending(),
      limits: this.screen.status().map((s) => ({ id: s.rule.id, label: s.rule.label, dailyMinutes: s.rule.dailyMinutes, usedMinutes: s.usedMinutes, leftMinutes: s.leftMinutes })),
      stream: this.stream.status(),
      members: isParent ? this.family.members().map((m) => ({ id: m.id, name: m.name, role: m.role })) : [],
      devices: isParent ? this.family.devices().map((d) => ({ id: d.id, name: d.name, memberName: d.memberName, lastSeen: d.lastSeen })) : [],
      activity: visibleActivity(actor, this.log.recent(60)),
      phone: { running: this.remote.phoneRunning(), urls: isParent ? this.phoneUrls() : [], error: this.phoneError, pairing: null },
    };
  }

  private streamActive(): boolean {
    const s = this.stream.status();
    return s.obs.state !== 'off' || s.twitch.state !== 'off';
  }

  private statusLines(): string[] {
    const lines: string[] = [];
    const t = this.takeover.state();
    lines.push(t.active ? `Take-over is ON until ${new Date(t.until).toLocaleTimeString()}: you may use type_text and press_keys.` : 'Take-over is off: to type or press keys you must first call take_over, which someone must approve.');
    if (this.gate.aiMode) lines.push('AI Mode is on: medium-risk actions run without asking. High-risk and money actions still ask.');
    const s = this.stream.status();
    lines.push(`Stream: OBS ${s.obs.state}, Twitch ${s.twitch.state}.${s.poll ? ` Poll open: ${s.poll}.` : ''}`);
    const limits = this.screen.status();
    if (limits.length) lines.push(`Screen-time limits today: ${limits.map((l) => `${l.rule.label} ${l.leftMinutes} min left`).join('; ')}.`);
    return lines;
  }

  /**
   * Counts screen time and enforces limits. This keeps running even after the stop switch:
   * the stop switch halts the AI, it must not be a way around a parent's limit.
   */
  private async screenTick(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastScreenTick;
    this.lastScreenTick = now;
    if (this.screen.rules().length === 0) return;
    let procs;
    try {
      procs = await listProcesses(this.sys);
    } catch {
      return;
    }
    for (const ev of this.screen.tick(procs, elapsed)) {
      if (ev.kind === 'warn') {
        const text = `${ev.leftMinutes} minute${ev.leftMinutes === 1 ? '' : 's'} of ${ev.rule.label} left today. Time to save your game!`;
        this.log.add('rule', 'info', 'Family rule', text);
        this.d.say(text);
        continue;
      }
      // First try lets the game save and close; if it is still open next time, force it.
      const tries = (this.enforcing.get(ev.rule.id) ?? 0) + 1;
      this.enforcing.set(ev.rule.id, tries);
      const names = [...new Set(ev.running.map((p) => p.name))];
      const results = await Promise.all(names.map((n) => closeApp(n, this.sys, tries > 1)));
      const closed = names.filter((_, i) => results[i]?.ok);
      if (closed.length) {
        this.log.add('rule', 'verified', 'Family rule', `${ev.rule.label} time is up (${ev.rule.dailyMinutes} min a day). Closed ${closed.join(', ')}.`);
        this.d.say(`${ev.rule.label} time is up for today. I closed ${closed.join(', ')}.`);
        this.enforcing.delete(ev.rule.id);
      } else {
        this.log.add('rule', 'failed', 'Family rule', `${ev.rule.label} time is up, but closing failed: ${results.map((r) => r?.text).join(' ')}`);
      }
    }
    this.d.changed();
  }
}

export const canManageFamily = (a: Actor): boolean => can({ id: a.id, familyId: 'local', role: a.role }, 'manage_members');

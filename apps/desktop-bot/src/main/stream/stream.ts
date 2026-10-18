// The streaming side of the bot (the Dexter-style copilot): OBS control, Twitch chat
// moderation, !commands, timed messages, polls, giveaways and the stream summary.
// It reuses apps/stream-copilot as-is. Its actions become ordinary bot tools, so the desktop
// bot's one gate decides what runs (bans and ending the stream always ask).

import { Copilot, type Outcome as StreamOutcome } from '@stream/copilot';
import { ObsClient } from '@stream/obs/client';
import { TOOLS, type Plan, type ToolName } from '@stream/tools';
import { TwitchClient } from '@stream/twitch/client';
import type { ExternalApprovals } from '../agent/agent';
import type { ActivityLog } from '../agent/activity';
import { fail, ok, num, str, type InputSchema, type Outcome, type ToolDef, type ToolResult } from '../agent/types';

export interface LinkStatus {
  state: 'off' | 'connecting' | 'connected' | 'error';
  detail: string;
}

export interface StreamStatusView {
  obs: LinkStatus;
  twitch: LinkStatus;
  poll: string | null;
  giveaway: string | null;
}

const INPUTS: Record<ToolName, InputSchema> = {
  obs_switch_scene: { type: 'object', properties: { scene: { type: 'string', description: 'Scene name, e.g. "BRB", "Gameplay"' } }, required: ['scene'] },
  obs_mute: { type: 'object', properties: { input: { type: 'string', description: 'Audio source, e.g. "Mic"' }, muted: { type: 'boolean' } }, required: ['input', 'muted'] },
  obs_start_stream: { type: 'object', properties: {} },
  obs_stop_stream: { type: 'object', properties: {} },
  chat_say: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  chat_timeout: { type: 'object', properties: { user: { type: 'string' }, seconds: { type: 'number' }, reason: { type: 'string' } }, required: ['user', 'seconds'] },
  chat_ban: { type: 'object', properties: { user: { type: 'string' }, reason: { type: 'string' } }, required: ['user'] },
  chat_pardon: { type: 'object', properties: { user: { type: 'string' } }, required: ['user'] },
  command_set: { type: 'object', properties: { name: { type: 'string', description: 'Without the !' }, reply: { type: 'string' } }, required: ['name', 'reply'] },
  poll_start: { type: 'object', properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['question', 'options'] },
  poll_end: { type: 'object', properties: {} },
  giveaway_start: { type: 'object', properties: { prize: { type: 'string' } } },
  giveaway_draw: { type: 'object', properties: {} },
  summary: { type: 'object', properties: {} },
};

/** Actions where OBS or Twitch's API answers, so success is confirmed. Chat posts get no receipt. */
const CONFIRMED: ReadonlySet<ToolName> = new Set(['obs_switch_scene', 'obs_mute', 'obs_start_stream', 'obs_stop_stream', 'chat_timeout', 'chat_ban', 'chat_pardon', 'command_set', 'summary', 'poll_end']);

function summarize(tool: ToolName, a: Record<string, unknown>): string {
  switch (tool) {
    case 'chat_ban': return `BAN ${str(a.user, 40)} from chat permanently${str(a.reason, 80) ? ` (${str(a.reason, 80)})` : ''}`;
    case 'chat_timeout': return `Time out ${str(a.user, 40)} for ${Math.round(num(a.seconds) / 60) || 1} min`;
    case 'obs_stop_stream': return 'END the live stream';
    case 'obs_start_stream': return 'Go live';
    case 'giveaway_draw': return 'Draw the giveaway winner';
    default: return TOOLS[tool].description;
  }
}

/** Fills in what the model may leave out, so the copilot always gets complete arguments. */
function complete(tool: ToolName, a: Record<string, unknown>): Record<string, unknown> {
  if (tool === 'chat_timeout') return { user: str(a.user, 40), seconds: Math.min(1_209_600, Math.max(1, num(a.seconds) || 600)), reason: str(a.reason, 200) || 'timed out by the streamer' };
  if (tool === 'chat_ban') return { user: str(a.user, 40), reason: str(a.reason, 200) || 'banned by the streamer' };
  if (tool === 'giveaway_start') return { prize: str(a.prize, 80) || 'a prize' };
  if (tool === 'poll_start') return { question: str(a.question, 200), options: Array.isArray(a.options) ? a.options.map((o) => str(o, 60)).filter(Boolean).slice(0, 6) : [] };
  return a;
}

const toResult = (tool: ToolName, out: StreamOutcome): ToolResult =>
  out.kind === 'done' ? ok(out.text, CONFIRMED.has(tool)) : out.kind === 'failed' ? fail(out.text) : fail(`Still waiting for an OK: ${out.summary}`);

export class StreamHub {
  readonly copilot: Copilot;
  private obs: ObsClient | null = null;
  private twitch: TwitchClient | null = null;
  private obsStatus: LinkStatus = { state: 'off', detail: 'Not connected' };
  private twitchStatus: LinkStatus = { state: 'off', detail: 'Not connected' };
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly log: ActivityLog, private readonly notify: (text: string) => void) {
    this.copilot = new Copilot({
      notify: (text) => {
        this.log.add('stream', 'info', 'Stream copilot', text);
        this.notify(text);
      },
    });
  }

  tools(): ToolDef[] {
    return (Object.keys(TOOLS) as ToolName[]).map((tool) => ({
      spec: { ...TOOLS[tool], name: `stream_${tool}` },
      input: INPUTS[tool],
      summarize: (a) => summarize(tool, a),
      roles: ['owner', 'admin', 'adult', 'teen', 'elder'],
      run: async (a) => toResult(tool, await this.copilot.runApproved({ tool, args: complete(tool, a) } as Plan)),
    }));
  }

  status(): StreamStatusView {
    const c = this.copilot;
    return {
      obs: { ...this.obsStatus },
      twitch: { ...this.twitchStatus },
      poll: c.poll?.open ? c.poll.question : null,
      giveaway: c.giveaway?.open ? `${c.giveaway.prize} (${c.giveaway.count} entered)` : null,
    };
  }

  async connectObs(url: string, password?: string): Promise<LinkStatus> {
    this.obs?.close();
    const client = new ObsClient();
    this.obsStatus = { state: 'connecting', detail: url };
    try {
      await client.connect(url || 'ws://127.0.0.1:4455', password || undefined);
      const { current } = await client.scenes();
      this.obs = client;
      this.copilot.attach({ obs: client });
      this.obsStatus = { state: 'connected', detail: `Live scene: ${current || '(none)'}` };
      this.log.add('stream', 'done', 'Stream copilot', 'OBS connected.');
    } catch (err) {
      client.close();
      this.obsStatus = { state: 'error', detail: (err as Error).message };
    }
    return { ...this.obsStatus };
  }

  async connectTwitch(clientId: string, token: string, channel: string): Promise<LinkStatus> {
    this.twitch?.close();
    if (!clientId || !token || !channel) {
      this.twitchStatus = { state: 'error', detail: 'Add the Twitch client ID, token and channel in Settings.' };
      return { ...this.twitchStatus };
    }
    const client = new TwitchClient({ clientId, token: token.replace(/^oauth:/, ''), channel });
    this.twitchStatus = { state: 'connecting', detail: `#${channel}` };
    this.copilot.attach({ chat: client });
    try {
      await client.connect((m) => {
        void this.copilot.onChat(m).then((action) => {
          if (action.kind !== 'allow') this.log.add('stream', 'done', 'Chat moderation', `${m.displayName}: ${action.kind} (${action.reason})`);
        });
      }, (notice) => this.log.add('stream', 'info', 'Twitch', notice));
      this.twitch = client;
      this.twitchStatus = { state: 'connected', detail: `#${channel.replace(/^#/, '')}` };
      this.log.add('stream', 'done', 'Stream copilot', `Twitch chat connected: #${channel}.`);
    } catch (err) {
      client.close();
      this.twitchStatus = { state: 'error', detail: (err as Error).message };
    }
    this.startTicker();
    return { ...this.twitchStatus };
  }

  disconnect(): void {
    this.obs?.close();
    this.twitch?.close();
    this.obs = null;
    this.twitch = null;
    this.obsStatus = { state: 'off', detail: 'Not connected' };
    this.twitchStatus = { state: 'off', detail: 'Not connected' };
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /** The copilot's own ban suggestions (from chat moderation) appear in the same approval list. */
  external(): ExternalApprovals {
    const c = this.copilot;
    const map = (o: StreamOutcome, tool: string): Outcome =>
      o.kind === 'done' ? { kind: 'done', tool, text: o.text, verified: true } : o.kind === 'failed' ? { kind: 'failed', tool, text: o.text } : { kind: 'needs_approval', tool, id: o.id, summary: o.summary };
    return {
      owns: (id) => /^req\d+$/.test(id),
      list: () => c.pendingApprovals().map((p) => ({ ...p, risk: 'high', requestedBy: 'Chat moderation', createdAt: Date.now() })),
      approve: async (id) => map(await c.approve(id), 'stream_chat_ban'),
      reject: (id) => map(c.reject(id), 'stream_chat_ban'),
    };
  }

  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.copilot.tick(), 60_000);
    this.ticker.unref?.();
  }
}

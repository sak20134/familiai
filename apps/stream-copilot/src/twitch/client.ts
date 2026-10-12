// Twitch through official channels only: chat over Twitch's IRC WebSocket, and moderation
// (delete, timeout, ban) through the Helix API with the streamer's own token.

import type { SocketFactory, SocketLike } from '../obs/client';
import type { ChatMessage } from '../types';
import { parseLine, privmsg } from './irc';

export const CHAT_URL = 'wss://irc-ws.chat.twitch.tv:443';
export const HELIX = 'https://api.twitch.tv/helix';

/** What the copilot needs from any chat platform. Tests use a fake; Twitch implements it below. */
export interface ChatPlatform {
  say(text: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
  timeout(userId: string, seconds: number, reason: string): Promise<void>;
  ban(userId: string, reason: string): Promise<void>;
}

export interface TwitchConfig {
  clientId: string;
  /** A user access token, without the "oauth:" prefix. Kept in .env, never in code. */
  token: string;
  channel: string;
  fetchImpl?: typeof fetch;
  socketFactory?: SocketFactory;
}

export class TwitchClient implements ChatPlatform {
  private socket: SocketLike | null = null;
  private ids: { broadcaster: string; moderator: string; login: string } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly channel: string;

  constructor(private readonly cfg: TwitchConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.channel = cfg.channel.toLowerCase().replace(/^#/, '');
  }

  /** Looks up who we are and whose channel this is, then joins chat. */
  async connect(onMessage: (m: ChatMessage) => void, onNotice?: (text: string) => void): Promise<void> {
    const me = await this.helix<{ data: Array<{ id: string; login: string }> }>('GET', '/users');
    const owner = await this.helix<{ data: Array<{ id: string }> }>('GET', `/users?login=${encodeURIComponent(this.channel)}`);
    if (!me.data[0]) throw new Error('Twitch did not recognise the token. Make a new one and put it in TWITCH_TOKEN.');
    if (!owner.data[0]) throw new Error(`There is no Twitch channel called "${this.channel}".`);
    this.ids = { broadcaster: owner.data[0].id, moderator: me.data[0].id, login: me.data[0].login };

    const factory = this.cfg.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    await new Promise<void>((resolve, reject) => {
      const sock = factory(CHAT_URL);
      let joined = false;
      sock.onopen = () => {
        sock.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        sock.send(`PASS oauth:${this.cfg.token}`);
        sock.send(`NICK ${this.ids!.login}`);
        sock.send(`JOIN #${this.channel}`);
      };
      sock.onerror = () => {
        if (!joined) reject(new Error('Could not reach Twitch chat.'));
      };
      sock.onclose = () => {
        this.socket = null;
        if (!joined) reject(new Error('Twitch closed the chat connection. Check the token and its scopes.'));
      };
      sock.onmessage = (e) => {
        for (const line of String(e.data).split('\r\n')) {
          if (!line) continue;
          if (!joined && / (366|ROOMSTATE) /.test(line)) {
            joined = true;
            this.socket = sock;
            resolve();
          }
          const ev = parseLine(line);
          if (ev.kind === 'ping') sock.send(ev.reply);
          else if (ev.kind === 'message') onMessage(ev.message);
          else if (ev.kind === 'notice') {
            if (!joined && /authentication failed|improperly formatted auth/i.test(ev.text)) reject(new Error('Twitch rejected the token.'));
            onNotice?.(ev.text);
          }
        }
      };
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  async say(text: string): Promise<void> {
    if (!this.socket) throw new Error('Not connected to Twitch chat.');
    this.socket.send(privmsg(this.channel, text));
  }

  async deleteMessage(messageId: string): Promise<void> {
    const { broadcaster, moderator } = this.need();
    await this.helix('DELETE', `/moderation/chat?broadcaster_id=${broadcaster}&moderator_id=${moderator}&message_id=${encodeURIComponent(messageId)}`);
  }

  async timeout(userId: string, seconds: number, reason: string): Promise<void> {
    const duration = Math.max(1, Math.min(1_209_600, Math.round(seconds))); // Twitch allows up to two weeks
    await this.banRequest({ user_id: userId, duration, reason: reason.slice(0, 500) });
  }

  async ban(userId: string, reason: string): Promise<void> {
    await this.banRequest({ user_id: userId, reason: reason.slice(0, 500) });
  }

  private async banRequest(data: Record<string, unknown>): Promise<void> {
    const { broadcaster, moderator } = this.need();
    await this.helix('POST', `/moderation/bans?broadcaster_id=${broadcaster}&moderator_id=${moderator}`, { data });
  }

  private need() {
    if (!this.ids) throw new Error('Not connected to Twitch yet.');
    return this.ids;
  }

  private async helix<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${HELIX}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        'client-id': this.cfg.clientId,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) throw new Error('Twitch says the token is invalid or expired.');
    if (res.status === 403) throw new Error('Twitch says this account is not allowed to do that here (is it a moderator of the channel?).');
    if (!res.ok) throw new Error(`Twitch refused (${res.status}): ${(await res.text()).slice(0, 160)}`);
    if (res.status === 204) return {} as T;
    return (await res.json()) as T;
  }
}

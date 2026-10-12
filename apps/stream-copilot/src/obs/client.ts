// Talks to OBS over its built-in WebSocket server. Every call waits for OBS to confirm,
// so the copilot never claims it switched a scene that did not switch.

import { AUTH_FAILED_CLOSE, identify, OP, parse, request, type Message } from './protocol';

/** The parts of a WebSocket we use. Node 22 and browsers both have one built in. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code: number; reason?: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface Scene { name: string }
export interface StreamStatus { live: boolean; durationMs: number }

const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export class ObsClient {
  private socket: SocketLike | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (d: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(type: string, data: Record<string, unknown>) => void>();

  constructor(private readonly factory: SocketFactory = defaultFactory, private readonly timeoutMs = 5000) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  /** Connects and logs in. Rejects with a plain-English reason if OBS is closed or the password is wrong. */
  connect(url: string, password?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let ready = false;
      const sock = this.factory(url);
      sock.onerror = () => {
        if (!ready) reject(new Error(`Could not reach OBS at ${url}. Is OBS open, with its WebSocket server turned on?`));
      };
      sock.onclose = (e) => {
        this.socket = null;
        this.failAll(new Error('OBS disconnected.'));
        if (!ready) {
          reject(new Error(e.code === AUTH_FAILED_CLOSE ? 'OBS rejected the password. Check OBS_PASSWORD.' : 'OBS closed the connection.'));
        }
      };
      sock.onmessage = (e) => {
        const msg = parse(String(e.data));
        if (!msg) return;
        if (msg.op === OP.Hello) {
          try {
            sock.send(JSON.stringify(identify(msg.d, password)));
          } catch (err) {
            reject(err as Error); // settle first: closing fires onclose, which would hide this reason
            sock.close();
          }
        } else if (msg.op === OP.Identified) {
          ready = true;
          this.socket = sock;
          resolve();
        } else {
          this.handle(msg);
        }
      };
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }

  /** Listen for OBS events (scene changed, stream started, ...). Returns a function that stops listening. */
  onEvent(fn: (type: string, data: Record<string, unknown>) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Sends one request and waits for OBS's answer. */
  call(requestType: string, data?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sock = this.socket;
    if (!sock) return Promise.reject(new Error('Not connected to OBS.'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OBS did not answer ${requestType} in time.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      sock.send(JSON.stringify(request(requestType, id, data)));
    });
  }

  async scenes(): Promise<{ current: string; scenes: Scene[] }> {
    const d = await this.call('GetSceneList');
    const list = (d.scenes as Array<{ sceneName: string }> | undefined) ?? [];
    // OBS lists scenes bottom-up; show them in the order the streamer sees.
    return { current: String(d.currentProgramSceneName ?? ''), scenes: [...list].reverse().map((s) => ({ name: s.sceneName })) };
  }

  async switchScene(name: string): Promise<void> {
    await this.call('SetCurrentProgramScene', { sceneName: name });
  }

  async inputs(): Promise<string[]> {
    const d = await this.call('GetInputList');
    return ((d.inputs as Array<{ inputName: string }> | undefined) ?? []).map((i) => i.inputName);
  }

  async setMute(inputName: string, muted: boolean): Promise<void> {
    await this.call('SetInputMute', { inputName, inputMuted: muted });
  }

  /** Volume in decibels: 0 is full, -100 is silent. */
  async setVolumeDb(inputName: string, db: number): Promise<void> {
    await this.call('SetInputVolume', { inputName, inputVolumeDb: Math.max(-100, Math.min(26, db)) });
  }

  async streamStatus(): Promise<StreamStatus> {
    const d = await this.call('GetStreamStatus');
    return { live: Boolean(d.outputActive), durationMs: Number(d.outputDuration ?? 0) };
  }

  async startStream(): Promise<void> {
    await this.call('StartStream');
  }

  async stopStream(): Promise<void> {
    await this.call('StopStream');
  }

  private handle(msg: Message): void {
    if (msg.op === OP.RequestResponse) {
      const id = String(msg.d.requestId);
      const waiting = this.pending.get(id);
      if (!waiting) return;
      this.pending.delete(id);
      clearTimeout(waiting.timer);
      const status = msg.d.requestStatus as { result?: boolean; code?: number; comment?: string } | undefined;
      if (status?.result) waiting.resolve((msg.d.responseData as Record<string, unknown> | undefined) ?? {});
      else waiting.reject(new Error(status?.comment ?? `OBS refused ${String(msg.d.requestType)} (code ${status?.code ?? '?'}).`));
    } else if (msg.op === OP.Event) {
      const type = String(msg.d.eventType);
      const data = (msg.d.eventData as Record<string, unknown> | undefined) ?? {};
      for (const fn of this.listeners) fn(type, data);
    }
  }

  private failAll(err: Error): void {
    for (const [id, w] of this.pending) {
      clearTimeout(w.timer);
      w.reject(err);
      this.pending.delete(id);
    }
  }
}

/** Finds a scene by a loose spoken name: "brb" matches "BRB", "be right back" matches "Be Right Back". */
export function matchName(spoken: string, names: readonly string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(spoken);
  if (!want) return null;
  const exact = names.find((n) => norm(n) === want);
  if (exact) return exact;
  const starts = names.filter((n) => norm(n).startsWith(want));
  if (starts.length === 1) return starts[0]!;
  const contains = names.filter((n) => norm(n).includes(want));
  return contains.length === 1 ? contains[0]! : null;
}

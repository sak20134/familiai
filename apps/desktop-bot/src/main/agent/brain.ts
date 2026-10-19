// The bot's own brain: a small open-source model (Qwen2.5, Apache-2.0) that runs inside the bot
// on this computer through llama.cpp. No Ollama, no Claude, no internet after the one-time
// download. It runs on the processor (the graphics card only when MONTEX_GPU=1), wakes up for the
// first question instead of at start-up, and goes back to sleep when nobody is talking to it, so
// it does not slow the computer down.
//
// The download is pinned to one exact file and checked against its published SHA-256 before it
// is ever loaded. An interrupted download resumes where it stopped.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatHistoryItem, ChatModelFunctionCall, ChatModelFunctions, LlamaChat } from 'node-llama-cpp';
import type { InputSchema } from './types';

export interface ModelSpec {
  name: string;
  file: string;
  url: string;
  size: number;
  sha256: string;
  license: string;
}

/** The brains that run on this computer. The screen only ever shows `label`, never the model name. */
export interface BrainSpec extends ModelSpec {
  id: 'default' | 'light';
  label: string;
}

export const BRAINS: readonly BrainSpec[] = [
  {
    id: 'default',
    label: 'Default',
    name: 'Qwen2.5 1.5B Instruct',
    // Stored under the bot's own name; the url below says exactly which file it is.
    file: 'familyai-brain.gguf',
    // Pinned to one commit, so the file can never change under us.
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    size: 1_117_320_736,
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    license: 'Apache-2.0',
  },
  {
    id: 'light',
    label: 'Light',
    name: 'Qwen2.5 0.5B Instruct',
    file: 'brain-light.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/9217f5db79a29953eb74d5343926648285ec7e67/qwen2.5-0.5b-instruct-q4_k_m.gguf',
    size: 491_400_032,
    sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',
    license: 'Apache-2.0',
  },
];

export const BRAIN_MODEL: BrainSpec = BRAINS[0]!;

export function brainById(id: string): BrainSpec {
  return BRAINS.find((b) => b.id === id) ?? BRAIN_MODEL;
}

/** missing: not downloaded · asleep: downloaded, not loaded yet · ready: loaded and answering */
export type BrainState = 'missing' | 'downloading' | 'asleep' | 'loading' | 'ready' | 'error';

export interface BrainStatus {
  state: BrainState;
  detail: string;
  /** 0..1 while downloading */
  progress?: number;
}

export interface GenerateResult {
  text: string;
  calls: Array<{ name: string; params: unknown; raw: unknown }>;
}

/** The part of the model the bot uses. Tests swap in a fake. */
export interface Engine {
  generate(history: ChatHistoryItem[], functions: ChatModelFunctions | undefined): Promise<GenerateResult>;
  close(): Promise<void>;
}

export type EngineLoader = (modelPath: string) => Promise<Engine>;

const MB = 1024 * 1024;

/** Downloads `spec` into `dir` (resuming a partial file) and checks its SHA-256. Returns the path. */
export async function downloadVerified(spec: ModelSpec, dir: string, opts: { fetchImpl?: typeof fetch; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {}): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, spec.file);
  const marker = `${target}.ok`;
  if (isVerified(spec, dir)) return target;

  const part = `${target}.part`;
  const hash = createHash('sha256');
  let have = 0;
  if (existsSync(part)) {
    have = statSync(part).size;
    if (have > spec.size) {
      rmSync(part);
      have = 0;
    } else {
      // Hash what is already there, so the final check covers the whole file.
      for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    }
  }

  if (have < spec.size) {
    const res = await (opts.fetchImpl ?? fetch)(spec.url, {
      headers: have > 0 ? { range: `bytes=${have}-` } : {},
      redirect: 'follow',
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (have > 0 && res.status === 200) {
      // The server ignored the resume request and sent the whole file: start over.
      await res.body?.cancel();
      return restart(spec, dir, opts);
    }
    if (!res.ok || !res.body) throw new Error(`Could not set up the brain (${res.status}). Check your internet connection and try again.`);
    const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
    const reader = res.body.getReader();
    let lastReport = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        hash.update(buf);
        have += buf.length;
        if (have > spec.size) throw new Error('The download is bigger than expected, so I stopped it.');
        if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
        if (have - lastReport > 4 * MB || have === spec.size) {
          lastReport = have;
          opts.onProgress?.(have, spec.size);
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()));
    }
  }

  if (have !== spec.size) throw new Error('The download stopped early. It will continue from where it stopped next time.');
  const digest = hash.digest('hex');
  if (digest !== spec.sha256) {
    rmSync(part, { force: true });
    throw new Error('The brain files did not pass their safety check, so they were deleted and NOT used. Try again.');
  }
  renameSync(part, target);
  writeFileSync(marker, spec.sha256);
  return target;
}

async function restart(spec: ModelSpec, dir: string, opts: Parameters<typeof downloadVerified>[2]): Promise<string> {
  rmSync(join(dir, `${spec.file}.part`), { force: true });
  return downloadVerified(spec, dir, opts);
}

export function isVerified(spec: ModelSpec, dir: string): boolean {
  const target = join(dir, spec.file);
  try {
    return statSync(target).size === spec.size && readFileSync(`${target}.ok`, 'utf8').trim() === spec.sha256;
  } catch {
    return false;
  }
}

/** Loads a model with node-llama-cpp. Processor only, unless MONTEX_GPU=1 asks for the graphics card. */
export const llamaLoader: EngineLoader = async (modelPath) => {
  const { getLlama, LlamaChat: Chat } = await import('node-llama-cpp');
  let llama;
  if (process.env.MONTEX_GPU === '1') {
    try {
      llama = await getLlama({ build: 'never', gpu: 'auto' });
    } catch {
      llama = await getLlama({ build: 'never', gpu: false });
    }
  } else {
    llama = await getLlama({ build: 'never', gpu: false });
  }
  const model = await llama.loadModel({ modelPath });
  // Fewer threads than cores, so the rest of the computer stays smooth, and never more than the
  // cores (extra threads fight each other: measured 10-17 s per answer instead of under 1 s).
  const context = await model.createContext({ contextSize: { min: 2048, max: 4096 }, threads: brainThreads(llama.cpuMathCores) });
  const chat: LlamaChat = new Chat({ contextSequence: context.getSequence() });
  let queue: Promise<unknown> = Promise.resolve();
  return {
    // One question at a time: the model has a single working memory.
    generate(history, functions) {
      const run = queue.then(async () => {
        const r = await chat.generateResponse(history, { ...(functions ? { functions } : {}), maxTokens: 700, temperature: 0.2 });
        return { text: r.response, calls: (r.functionCalls ?? []).map((c) => ({ name: String(c.functionName), params: c.params, raw: c.raw })) };
      });
      queue = run.catch(() => undefined);
      return run;
    },
    async close() {
      await context.dispose();
      await model.dispose();
      await llama.dispose();
    },
  };
};

/** Threads for the model: leave one core free, use at most four. */
export function brainThreads(cores: number): number {
  return Math.max(1, Math.min(4, cores - 1));
}

/** How long the model stays loaded with nobody talking to it. */
export const IDLE_UNLOAD_MS = 5 * 60_000;

export interface BrainOptions {
  dir: string;
  spec?: ModelSpec;
  loader?: EngineLoader;
  fetchImpl?: typeof fetch;
  onStatus?: (s: BrainStatus) => void;
  /** Milliseconds of quiet before the model is unloaded. 0 keeps it loaded. */
  idleMs?: number;
}

export class Brain {
  private chosen: ModelSpec;
  private current: BrainStatus;
  private loading: Promise<Engine> | null = null;
  private fetching: Promise<string> | null = null;
  private engine: Engine | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = 0;
  /** Changes whenever the choice changes, so a slow load for the old choice is thrown away. */
  private generation = 0;

  constructor(private readonly o: BrainOptions) {
    this.chosen = o.spec ?? BRAIN_MODEL;
    this.current = this.resting();
  }

  get spec(): ModelSpec {
    return this.chosen;
  }

  status(): BrainStatus {
    return { ...this.current };
  }

  get downloaded(): boolean {
    return isVerified(this.chosen, this.o.dir);
  }

  /** Switches to another brain. The old one is put to sleep; the new one wakes on the next question. */
  async select(spec: ModelSpec): Promise<void> {
    if (spec.file === this.chosen.file) return;
    this.generation++;
    this.chosen = spec;
    this.loading = null;
    this.fetching = null;
    await this.close();
    this.set(this.resting());
  }

  /** Makes sure the files are there (downloads them if not). It does NOT load the model. */
  prepare(): void {
    this.fetch().catch(() => undefined);
  }

  /** The loaded model, downloading and loading it first if needed. Concurrent callers share one load. */
  ensure(): Promise<Engine> {
    if (this.engine) return Promise.resolve(this.engine);
    const gen = this.generation;
    this.loading ??= this.load(gen).finally(() => { if (gen === this.generation) this.loading = null; });
    return this.loading;
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const e = this.engine;
    this.engine = null;
    await e?.close();
  }

  private resting(): BrainStatus {
    return isVerified(this.chosen, this.o.dir)
      ? { state: 'asleep', detail: 'Ready. Wakes up for the first question.' }
      : { state: 'missing', detail: 'Not set up yet.' };
  }

  private fetch(): Promise<string> {
    const gen = this.generation;
    const spec = this.chosen;
    if (!this.fetching) {
      const run = downloadVerified(spec, this.o.dir, {
        ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
        onProgress: (done, total) => { if (gen === this.generation) this.set({ state: 'downloading', progress: done / total, detail: `Setting up my brain: ${Math.round((done / total) * 100)}%` }); },
      }).then(
        (path) => {
          if (gen === this.generation && this.current.state !== 'ready' && this.current.state !== 'loading') this.set({ state: 'asleep', detail: 'Ready. Wakes up for the first question.' });
          return path;
        },
        (err) => {
          if (gen === this.generation) this.set({ state: 'error', detail: err instanceof Error ? err.message : String(err) });
          throw err;
        },
      );
      this.fetching = run;
      const clear = () => { if (this.fetching === run) this.fetching = null; };
      run.then(clear, clear);
    }
    return this.fetching;
  }

  private async load(gen: number): Promise<Engine> {
    const path = await this.fetch();
    try {
      this.set({ state: 'loading', detail: 'Waking up my brain...' });
      const raw = await (this.o.loader ?? llamaLoader)(path);
      if (gen !== this.generation) {
        await raw.close();
        throw new Error('The brain was changed while it was waking up.');
      }
      this.engine = this.watched(raw);
      this.set({ state: 'ready', detail: 'Awake.' });
      this.touch();
      return this.engine;
    } catch (err) {
      if (gen === this.generation) this.set({ state: 'error', detail: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  /** Wraps the model so the brain knows when it is busy and when it has been quiet for a while. */
  private watched(raw: Engine): Engine {
    return {
      generate: async (history, functions) => {
        this.busy++;
        if (this.timer) clearTimeout(this.timer);
        try {
          return await raw.generate(history, functions);
        } finally {
          this.busy--;
          this.touch();
        }
      },
      close: () => raw.close(),
    };
  }

  private touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ms = this.o.idleMs ?? IDLE_UNLOAD_MS;
    if (!this.engine || ms <= 0 || this.busy > 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.busy > 0) return;
      this.close().then(() => this.set({ state: 'asleep', detail: 'Resting. Wakes up for the next question.' }), () => undefined);
    }, ms);
    this.timer.unref?.();
  }

  private set(s: BrainStatus): void {
    this.current = s;
    this.o.onStatus?.(s);
  }
}

// --- talking to it with tools --------------------------------------------------------------

/**
 * Tool schemas for the built-in brain. Its grammar makes every listed field required, so fields
 * that are optional for the bot may be null; nulls are removed before the tool sees them.
 */
export function toFunctions(tools: ReadonlyArray<{ name: string; description: string; input: InputSchema }>): ChatModelFunctions {
  const out: Record<string, { description: string; params: unknown }> = {};
  for (const t of tools) {
    const props = Object.entries(t.input.properties);
    if (props.length === 0) {
      out[t.name] = { description: t.description, params: undefined };
      continue;
    }
    const required = new Set(t.input.required ?? []);
    const properties: Record<string, unknown> = {};
    for (const [key, p] of props) {
      const base: Record<string, unknown> = p.enum ? { enum: [...p.enum] } : p.type === 'array' ? { type: 'array', items: { type: p.items?.type ?? 'string' } } : { type: p.type };
      properties[key] = required.has(key) ? base : { oneOf: [base, { type: 'null' }] };
    }
    out[t.name] = { description: t.description, params: { type: 'object', properties } };
  }
  return out as ChatModelFunctions;
}

/**
 * Small models sometimes write a tool call as text instead of making it, for example
 * {"name": "remember", "arguments": {...}}. This reads that back as a call, but only for a tool
 * that really exists; the call still goes through the gate like any other.
 */
export function callFromText(text: string, toolNames: ReadonlySet<string>): { name: string; params: Record<string, unknown> } | null {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').replace(/^<tool_call>\s*|\s*<\/tool_call>$/g, '');
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try {
    const j = JSON.parse(t) as { name?: unknown; arguments?: unknown; parameters?: unknown };
    if (typeof j.name !== 'string' || !toolNames.has(j.name)) return null;
    const args = j.arguments ?? j.parameters ?? {};
    return { name: j.name, params: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {} };
  } catch {
    return null;
  }
}

export function dropNulls(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  return Object.fromEntries(Object.entries(params as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined));
}

/** A conversation in the shape llama.cpp's chat expects, continued step by step. */
export class BrainConversation {
  readonly history: ChatHistoryItem[];
  private pending: ChatModelFunctionCall[] = [];
  /** True while the model's answer is still open because it is waiting for tool results. */
  private open = false;

  constructor(system: string, turns: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>) {
    this.history = [{ type: 'system', text: system }, ...turns.map((t): ChatHistoryItem => (t.role === 'user' ? { type: 'user', text: t.content } : { type: 'model', response: [t.content] }))];
  }

  /** Adds what the model just said, and the calls it wants, to its answer. */
  record(result: GenerateResult): void {
    const last = this.history[this.history.length - 1];
    let answer: Extract<ChatHistoryItem, { type: 'model' }>;
    if (this.open && last?.type === 'model') {
      answer = last;
    } else {
      answer = { type: 'model', response: [] };
      this.history.push(answer);
    }
    if (result.text) answer.response.push(result.text);
    this.pending = result.calls.map((c) => ({ type: 'functionCall', name: c.name, params: c.params, result: undefined, rawCall: c.raw as ChatModelFunctionCall['rawCall'] }));
    answer.response.push(...this.pending);
    this.open = this.pending.length > 0;
  }

  /** Fills in the results of the calls from the last step, in order. */
  results(contents: readonly string[]): void {
    this.pending.forEach((c, i) => { c.result = contents[i] ?? 'No result.'; });
    this.pending = [];
  }
}

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityLog } from '../src/main/agent/activity';
import { Agent } from '../src/main/agent/agent';
import { Brain, BrainConversation, callFromText, downloadVerified, dropNulls, isVerified, toFunctions, type Engine, type GenerateResult, type ModelSpec } from '../src/main/agent/brain';
import { Gate } from '../src/main/agent/gate';
import { MemoryStore } from '../src/main/agent/memory';
import { ok, type Actor, type ToolDef } from '../src/main/agent/types';

const BYTES = Buffer.from('pretend model weights '.repeat(500));
const spec = (over: Partial<ModelSpec> = {}): ModelSpec => ({
  name: 'Test brain', file: 'test.gguf', url: 'https://example.com/test.gguf', size: BYTES.length,
  sha256: createHash('sha256').update(BYTES).digest('hex'), license: 'MIT', ...over,
});

/** A pretend download server that honours Range requests, like Hugging Face. */
function server(body: Buffer, opts: { ignoreRange?: boolean } = {}) {
  const seen: Array<string | undefined> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.range;
    seen.push(range);
    const from = range && !opts.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    return new Response(new Uint8Array(body.subarray(from)), { status: from > 0 ? 206 : 200 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'brain-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('brain download', () => {
  it('downloads, checks the checksum, and does not download again', async () => {
    const s = server(BYTES);
    const progress: number[] = [];
    const path = await downloadVerified(spec(), dir, { fetchImpl: s.fetchImpl, onProgress: (d) => progress.push(d) });
    expect(readFileSync(path).equals(BYTES)).toBe(true);
    expect(isVerified(spec(), dir)).toBe(true);
    expect(progress.at(-1)).toBe(BYTES.length);
    await downloadVerified(spec(), dir, { fetchImpl: s.fetchImpl });
    expect(s.seen).toHaveLength(1);
  });

  it('resumes an interrupted download from where it stopped', async () => {
    writeFileSync(join(dir, 'test.gguf.part'), BYTES.subarray(0, 4000));
    const s = server(BYTES);
    await downloadVerified(spec(), dir, { fetchImpl: s.fetchImpl });
    expect(s.seen[0]).toBe('bytes=4000-');
    expect(readFileSync(join(dir, 'test.gguf')).equals(BYTES)).toBe(true);
  });

  it('starts over when the server ignores the resume request', async () => {
    writeFileSync(join(dir, 'test.gguf.part'), BYTES.subarray(0, 4000));
    const s = server(BYTES, { ignoreRange: true });
    await downloadVerified(spec(), dir, { fetchImpl: s.fetchImpl });
    expect(s.seen).toEqual(['bytes=4000-', undefined]);
    expect(isVerified(spec(), dir)).toBe(true);
  });

  it('deletes and refuses a file that does not match the official checksum', async () => {
    const s = server(Buffer.from(BYTES).fill(1, 100, 110));
    await expect(downloadVerified(spec(), dir, { fetchImpl: s.fetchImpl })).rejects.toThrow(/checksum.*NOT used/);
    expect(existsSync(join(dir, 'test.gguf'))).toBe(false);
    expect(existsSync(join(dir, 'test.gguf.part'))).toBe(false);
  });

  it('stops a download that is bigger than expected', async () => {
    const s = server(Buffer.concat([BYTES, BYTES]));
    await expect(downloadVerified(spec(), dir, { fetchImpl: s.fetchImpl })).rejects.toThrow(/bigger than expected/);
  });
});

describe('brain status and loading', () => {
  it('reports missing, downloading and ready, and loads only once for parallel callers', async () => {
    const states: string[] = [];
    let loads = 0;
    const engine: Engine = { generate: async () => ({ text: 'hi', calls: [] }), close: async () => {} };
    const b = new Brain({ dir, spec: spec(), fetchImpl: server(BYTES).fetchImpl, loader: async () => { loads++; return engine; }, onStatus: (s) => states.push(s.state) });
    expect(b.status().state).toBe('missing');
    const [a, c] = await Promise.all([b.ensure(), b.ensure()]);
    expect(a).toBe(c);
    expect(loads).toBe(1);
    expect(states).toEqual(['downloading', 'loading', 'ready']);
    expect(new Brain({ dir, spec: spec() }).status().state).toBe('asleep');
  });
  it('shows a plain error when loading fails', async () => {
    const b = new Brain({ dir, spec: spec(), fetchImpl: server(BYTES).fetchImpl, loader: async () => { throw new Error('not enough memory'); } });
    await expect(b.ensure()).rejects.toThrow('not enough memory');
    expect(b.status()).toMatchObject({ state: 'error', detail: 'not enough memory' });
  });
});

describe('talking to the brain', () => {
  it('makes optional fields nullable, because the grammar requires every field', () => {
    const f = toFunctions([{ name: 'take_over', description: 'd', input: { type: 'object', properties: { minutes: { type: 'number' }, task: { type: 'string' } }, required: ['task'] } }, { name: 'list_apps', description: 'l', input: { type: 'object', properties: {} } }]) as Record<string, { params?: { properties: Record<string, unknown> } }>;
    expect(f.take_over?.params?.properties.minutes).toEqual({ oneOf: [{ type: 'number' }, { type: 'null' }] });
    expect(f.take_over?.params?.properties.task).toEqual({ type: 'string' });
    expect(f.list_apps?.params).toBeUndefined();
    expect(dropNulls({ a: 1, b: null, c: undefined })).toEqual({ a: 1 });
  });
  it('reads a tool call written as text, but only for real tools', () => {
    const names = new Set(['remember']);
    expect(callFromText('{"name": "remember", "arguments": {"text": "x"}}', names)).toEqual({ name: 'remember', params: { text: 'x' } });
    expect(callFromText('```json\n{"name":"remember","arguments":{}}\n```', names)?.name).toBe('remember');
    expect(callFromText('{"name": "delete_everything", "arguments": {}}', names)).toBeNull();
    expect(callFromText('Paris is the capital.', names)).toBeNull();
  });
  it('keeps the conversation in the shape the model expects', () => {
    const c = new BrainConversation('sys', [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
    c.record({ text: 'Let me check.', calls: [{ name: 'list_apps', params: {}, raw: undefined }] });
    c.results(['Running: obs.']);
    c.record({ text: 'OBS is running.', calls: [] });
    expect(c.history).toHaveLength(4);
    const answer = c.history[3] as { type: 'model'; response: unknown[] };
    expect(answer.response).toEqual(['Let me check.', expect.objectContaining({ type: 'functionCall', name: 'list_apps', result: 'Running: obs.' }), 'OBS is running.']);
  });

  it('runs end to end through the agent and the gate with a pretend engine', async () => {
    writeFileSync(join(dir, 'test.gguf'), BYTES);
    writeFileSync(join(dir, 'test.gguf.ok'), spec().sha256);
    const answers: GenerateResult[] = [
      { text: '', calls: [{ name: 'close_app', params: { app: 'roblox' }, raw: undefined }] },
      { text: 'Done, I closed Roblox!', calls: [] },
    ];
    const engine: Engine = { generate: async () => answers.shift()!, close: async () => {} };
    const brain = new Brain({ dir, spec: spec(), loader: async () => engine });
    const tool: ToolDef = { spec: { name: 'close_app', risk: 'medium', description: 'Close an app.' }, input: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] }, run: async () => ok('Closed.') };
    const agent = new Agent({ tools: [tool], planners: [], gate: new Gate(), log: new ActivityLog(join(dir, 'a')), memory: new MemoryStore(join(dir, 'm')), model: () => ({ provider: 'builtin', model: 'x', brain }), botName: () => 'Pixel' });
    const me: Actor = { id: 'owner', name: 'S', role: 'owner', via: 'desktop' };
    const r = await agent.handle('get rid of roblox please', me);
    expect(r.outcomes[0]?.kind).toBe('needs_approval');
    expect(r.text).toContain('Waiting for your OK'); // the brain's "Done" never stands alone
  });

  it('says plainly that the brain is still downloading, without waiting for it', async () => {
    const brain = new Brain({ dir, spec: spec(), fetchImpl: (async () => new Promise(() => {})) as unknown as typeof fetch });
    const agent = new Agent({ tools: [], planners: [], gate: new Gate(), log: new ActivityLog(join(dir, 'a')), memory: new MemoryStore(join(dir, 'm')), model: () => ({ provider: 'builtin', model: 'x', brain }), botName: () => 'Pixel' });
    const r = await agent.handle('tell me a joke', { id: 'o', name: 'S', role: 'owner', via: 'desktop' });
    expect(r.text).toMatch(/getting my brain ready/);
  });
});

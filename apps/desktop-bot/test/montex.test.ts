import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiEngine, parseApiUrl, toApiMessages, toApiTools } from '../src/main/agent/api-brain';
import { BRAINS, Brain, brainById, brainThreads, type Engine, type ModelSpec } from '../src/main/agent/brain';
import { parseConfig } from '../src/main/config';
// @ts-expect-error plain .mjs helper without types
import { brandedPackage, readBrand } from '../scripts/brand.mjs';

const BYTES = Buffer.from('weights '.repeat(300));
const spec = (file: string): ModelSpec => ({ name: 't', file, url: `https://example.com/${file}`, size: BYTES.length, sha256: createHash('sha256').update(BYTES).digest('hex'), license: 'MIT' });
const okFetch = (() => Promise.resolve(new Response(new Uint8Array(BYTES), { status: 200 }))) as typeof fetch;

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'montex-')); });
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

function fakeLoader() {
  const log = { loads: 0, closes: 0 };
  const engine: Engine = { generate: async () => ({ text: 'hi', calls: [] }), close: async () => { log.closes++; } };
  return { log, loader: async () => { log.loads++; return engine; } };
}

describe('lighter brain', () => {
  it('prepare downloads but does not load the model', async () => {
    const f = fakeLoader();
    const b = new Brain({ dir, spec: spec('a.gguf'), loader: f.loader, fetchImpl: okFetch });
    b.prepare();
    await vi.waitFor(() => expect(b.downloaded).toBe(true));
    expect(f.log.loads).toBe(0);
    expect(b.status().state).toBe('asleep');
    await b.ensure();
    expect(f.log.loads).toBe(1);
  });

  it('unloads after quiet time and wakes again for the next question', async () => {
    vi.useFakeTimers();
    const f = fakeLoader();
    const b = new Brain({ dir, spec: spec('a.gguf'), loader: f.loader, fetchImpl: okFetch, idleMs: 1000 });
    const e = await b.ensure();
    await e.generate([], undefined);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.log.closes).toBe(1);
    expect(b.status().state).toBe('asleep');
    await b.ensure();
    expect(f.log.loads).toBe(2);
  });

  it('switching brain puts the old one to sleep', async () => {
    const f = fakeLoader();
    const b = new Brain({ dir, spec: spec('a.gguf'), loader: f.loader, fetchImpl: okFetch, idleMs: 0 });
    await b.ensure();
    await b.select(spec('b.gguf'));
    expect(f.log.closes).toBe(1);
    expect(b.spec.file).toBe('b.gguf');
    expect(b.status().state).toBe('missing');
  });

  it('keeps one thread free and caps threads at four', () => {
    expect([brainThreads(1), brainThreads(2), brainThreads(4), brainThreads(16)]).toEqual([1, 1, 3, 4]);
  });

  it('has Default and Light brains with distinct files', () => {
    expect(BRAINS.map((x) => x.label)).toEqual(['Default', 'Light']);
    expect(new Set(BRAINS.map((x) => x.file)).size).toBe(2);
    expect(brainById('nope').id).toBe('default');
  });
});

describe('brain settings', () => {
  it('defaults to the Default brain and rejects unknown values', () => {
    expect(parseConfig({}).brain).toBe('default');
    expect(parseConfig({ brain: 'hacked' }).brain).toBe('default');
    expect(parseConfig({ brain: 'api', apiUrl: ' https://x.io/v1 ', apiModel: 'deepseek-chat' })).toMatchObject({ brain: 'api', apiUrl: 'https://x.io/v1', apiModel: 'deepseek-chat' });
  });
});

describe('own API brain', () => {
  it('only allows https, or http on this computer', () => {
    expect(parseApiUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1');
    expect(parseApiUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(parseApiUrl('http://example.com/v1')).toBeNull();
    expect(parseApiUrl('https://user:pw@example.com')).toBeNull();
    expect(parseApiUrl('nonsense')).toBeNull();
  });

  it('converts the conversation and tools to the chat format', () => {
    const msgs = toApiMessages([
      { type: 'system', text: 'sys' },
      { type: 'user', text: 'close notepad' },
      { type: 'model', response: [{ type: 'functionCall', name: 'close_app', params: { name: 'notepad' }, result: 'Closed.' }, 'Done.'] },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant']);
    expect(msgs[2]).toMatchObject({ tool_calls: [{ id: 'call_1', function: { name: 'close_app', arguments: '{"name":"notepad"}' } }] });
    expect(msgs[3]).toMatchObject({ tool_call_id: 'call_1', content: 'Closed.' });
    const tools = toApiTools({ close_app: { description: 'Close', params: { type: 'object', properties: { name: { type: 'string' }, force: { oneOf: [{ type: 'boolean' }, { type: 'null' }] } } } } } as never);
    expect(tools[0]!.function.parameters).toEqual({ type: 'object', properties: { name: { type: 'string' }, force: { type: 'boolean' } }, required: ['name'] });
  });

  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const fns = { close_app: { description: 'Close', params: { type: 'object', properties: { name: { type: 'string' } } } } } as never;

  it('returns text and tool calls, ignoring unknown tools and thinking text', async () => {
    const e = createApiEngine({ baseUrl: 'https://x.io/v1', model: 'm', apiKey: 'k', fetchImpl: reply({ choices: [{ message: { content: '<think>hm</think>Okay', tool_calls: [{ function: { name: 'close_app', arguments: '{"name":"notepad"}' } }, { function: { name: 'rm_rf', arguments: '{}' } }] } }] }) });
    const r = await e.generate([{ type: 'user', text: 'hi' }], fns);
    expect(r.text).toBe('Okay');
    expect(r.calls).toEqual([{ name: 'close_app', params: { name: 'notepad' }, raw: undefined }]);
  });

  it('sends the key only as a header and explains errors kindly', async () => {
    const seen: RequestInit[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => { seen.push(init!); return new Response('no', { status: 401 }); }) as typeof fetch;
    const e = createApiEngine({ baseUrl: 'https://x.io/v1', model: 'm', apiKey: 'sekret', fetchImpl: f });
    await expect(e.generate([{ type: 'user', text: 'hi' }], undefined)).rejects.toThrow(/did not accept the key/);
    expect((seen[0]!.headers as Record<string, string>).authorization).toBe('Bearer sekret');
    expect(String(seen[0]!.body)).not.toContain('sekret');
    await expect(createApiEngine({ baseUrl: 'https://x.io', model: 'm', apiKey: 'k', fetchImpl: reply({}, 429) }).generate([], undefined)).rejects.toThrow(/too many requests/);
    await expect(createApiEngine({ baseUrl: 'https://x.io', model: 'm', apiKey: 'k', fetchImpl: (async () => { throw new Error('x'); }) as never }).generate([], undefined)).rejects.toThrow(/could not reach/);
  });

  it('refuses bad settings up front', () => {
    expect(() => createApiEngine({ baseUrl: 'http://example.com', model: 'm', apiKey: 'k' })).toThrow(/https/);
    expect(() => createApiEngine({ baseUrl: 'https://x.io', model: '', apiKey: 'k' })).toThrow(/model name/);
    expect(() => createApiEngine({ baseUrl: 'https://x.io', model: 'm', apiKey: '' })).toThrow(/API key/);
    expect(() => createApiEngine({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'm', apiKey: '' })).not.toThrow();
  });
});

describe('brand', () => {
  it('package.json matches brand.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    expect(brandedPackage(pkg, readBrand())).toEqual(pkg);
    expect(readBrand().author).toBe('Sakthi Yokesh');
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeBackground } from '../src/main/background';
import { buildRequestBody, demoReply, parseModelReply, reply } from '../src/main/chat';
import { parseEnv } from '../src/main/env';
import { detectImageType, isAllowedDownloadUrl, MAX_IMAGE_BYTES, pngDataUrlToBuffer, validateImage } from '../src/main/images';
import { buildSearchUrl, cleanQuery, parseResults, searchImages } from '../src/main/openverse';
import { DEFAULT_SETTINGS, parseSettings, SettingsStore } from '../src/main/settings';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('images', () => {
  it('detects types by content, not by name', () => {
    expect(detectImageType(PNG)).toBe('png');
    expect(detectImageType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('gif');
    expect(detectImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(detectImageType(new TextEncoder().encode('<svg onload=alert(1)>'))).toBeNull();
  });
  it('rejects empty, huge and non-image files', () => {
    expect(validateImage(new Uint8Array())).toMatchObject({ ok: false });
    expect(validateImage(new Uint8Array(MAX_IMAGE_BYTES + 1))).toMatchObject({ ok: false });
    expect(validateImage(new TextEncoder().encode('hello world!'))).toMatchObject({ ok: false });
    expect(validateImage(PNG)).toEqual({ ok: true, type: 'png' });
  });
  it('only allows https downloads from the image source', () => {
    expect(isAllowedDownloadUrl('https://api.openverse.org/v1/images/abc/thumb/')).toBe(true);
    expect(isAllowedDownloadUrl('http://api.openverse.org/x')).toBe(false);
    expect(isAllowedDownloadUrl('https://evil.example.com/x.png')).toBe(false);
    expect(isAllowedDownloadUrl('https://api.openverse.org.evil.com/x')).toBe(false);
    expect(isAllowedDownloadUrl('https://user:pw@api.openverse.org/x')).toBe(false);
    expect(isAllowedDownloadUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedDownloadUrl('not a url')).toBe(false);
  });
  it('accepts only real PNG data URLs', () => {
    const good = 'data:image/png;base64,' + Buffer.from(PNG).toString('base64');
    expect(pngDataUrlToBuffer(good)).not.toBeNull();
    expect(pngDataUrlToBuffer('data:image/png;base64,' + Buffer.from('hello world').toString('base64'))).toBeNull();
    expect(pngDataUrlToBuffer('data:text/html;base64,PGI+')).toBeNull();
    expect(pngDataUrlToBuffer('data:image/png;base64,@@@')).toBeNull();
  });
});

describe('openverse', () => {
  it('cleans queries and builds a safe search url', () => {
    expect(cleanQuery('  orange   cat ')).toBe('orange cat');
    expect(cleanQuery('a')).toBeNull();
    expect(cleanQuery('x'.repeat(81))).toBeNull();
    const url = new URL(buildSearchUrl('orange cat'));
    expect(url.hostname).toBe('api.openverse.org');
    expect(url.searchParams.get('mature')).toBe('false');
    expect(url.searchParams.get('q')).toBe('orange cat');
  });
  it('keeps only licensed, non-mature results', () => {
    const out = parseResults({
      results: [
        { id: 'a', title: 'Cat', thumbnail: 'https://api.openverse.org/v1/images/a/thumb/', license: 'by', license_version: '4.0', creator: 'Sam' },
        { id: 'b', thumbnail: 'https://x', license: 'by', mature: true },
        { id: 'c', thumbnail: 'https://x' }, // no license
        { thumbnail: 'https://x', license: 'by' }, // no id
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', license: 'CC BY 4.0', creator: 'Sam' });
    expect(parseResults(null)).toEqual([]);
    expect(parseResults({ results: 'nope' })).toEqual([]);
  });
  it('reports a failed search clearly', async () => {
    await expect(searchImages('cat', async () => new Response('x', { status: 429 }))).rejects.toThrow('429');
  });
});

describe('settings', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('sanitizes bad values', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ botName: '   ', imagePath: 5, quiet: 'yes' })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ botName: 'x'.repeat(100) }).botName).toHaveLength(30);
  });
  it('saves, reloads, and survives a corrupt file', () => {
    dir = mkdtempSync(join(tmpdir(), 'bot-'));
    const a = new SettingsStore(dir);
    a.update({ botName: 'Milo', quiet: true });
    expect(new SettingsStore(dir).get()).toMatchObject({ botName: 'Milo', quiet: true });
    writeFileSync(join(dir, 'settings.json'), '{not json', 'utf8');
    expect(new SettingsStore(dir).get()).toEqual(DEFAULT_SETTINGS);
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toContain('not json');
  });
});

describe('chat', () => {
  it('gives a demo reply without a key and never calls the network', async () => {
    let called = false;
    const r = await reply({
      message: 'hi', history: [], botName: 'Milo', apiKey: undefined, model: 'm',
      fetchImpl: async () => { called = true; return new Response('{}'); },
    });
    expect(r.demo).toBe(true);
    expect(called).toBe(false);
    expect(demoReply('who are you', 'Milo')).toContain('Milo');
  });
  it('sends a model request with the key in a header, not the body', async () => {
    let seen: { headers?: Record<string, string>; body?: string } = {};
    const r = await reply({
      message: 'hello', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }],
      botName: 'Milo', apiKey: 'sk-test', model: 'claude-sonnet-5-5',
      fetchImpl: async (_url, init) => {
        seen = { headers: init?.headers as Record<string, string>, body: String(init?.body) };
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Hi there!' }] }), { status: 200 });
      },
    });
    expect(r).toEqual({ text: 'Hi there!', demo: false });
    expect(seen.headers?.['x-api-key']).toBe('sk-test');
    expect(seen.body).not.toContain('sk-test');
    expect(JSON.parse(seen.body ?? '{}').messages).toHaveLength(3);
  });
  it('shows the real failure and not the key', async () => {
    const p = reply({
      message: 'hello', history: [], botName: 'Milo', apiKey: 'sk-secret', model: 'm',
      fetchImpl: async () => new Response('invalid key', { status: 401 }),
    });
    await expect(p).rejects.toThrow('401');
    await expect(p).rejects.not.toThrow('sk-secret');
  });
  it('rejects empty messages and odd model answers', async () => {
    await expect(reply({ message: '  ', history: [], botName: 'M', apiKey: undefined, model: 'm' })).rejects.toThrow();
    expect(() => parseModelReply({ content: [] })).toThrow();
    expect(() => parseModelReply({})).toThrow();
    expect(buildRequestBody([], 'm', 'Milo').system).toContain('Milo');
  });
});

describe('env', () => {
  it('parses simple files', () => {
    expect(parseEnv('# c\nA=1\nB = "two"\n\nBAD LINE\nC=\n1X=3\n')).toEqual({ A: '1', B: 'two' });
  });
});

describe('background removal', () => {
  const make = (w: number, h: number, fill: [number, number, number]) => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) a.set([...fill, 255], i * 4);
    return a;
  };
  it('clears a plain background but keeps the subject', () => {
    const w = 10, h = 10, px = make(w, h, [255, 255, 255]);
    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) px.set([200, 30, 30, 255], (y * w + x) * 4);
    const r = removeBackground(px, w, h);
    expect(r.removed).toBe(100 - 16);
    expect(px[3]).toBe(0); // corner now transparent
    expect(px[(5 * w + 5) * 4 + 3]).toBe(255); // subject untouched
  });
  it('leaves a white hole inside the subject alone', () => {
    const w = 9, h = 9, px = make(w, h, [255, 255, 255]);
    for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) px.set([20, 20, 20, 255], (y * w + x) * 4);
    px.set([255, 255, 255, 255], (4 * w + 4) * 4); // eye-like white dot, enclosed
    removeBackground(px, w, h);
    expect(px[(4 * w + 4) * 4 + 3]).toBe(255);
  });
  it('does nothing on a busy background', () => {
    const w = 6, h = 6, px = make(w, h, [255, 255, 255]);
    px.set([0, 0, 0, 255], (5 * w + 5) * 4);
    const r = removeBackground(px, w, h);
    expect(r.removed).toBe(0);
    expect(r.skippedReason).toBeDefined();
    expect(removeBackground(new Uint8Array(3), 1, 1).removed).toBe(0);
  });
});

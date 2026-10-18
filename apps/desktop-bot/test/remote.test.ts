import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Outcome, Reply } from '../src/main/agent/types';
import { Family } from '../src/main/family/family';
import { RemoteServer, visibleActivity, type BotFacade } from '../src/main/remote/server';

const owner: Actor = { id: 'owner', name: 'Sakthi', role: 'owner', via: 'desktop' };

/** Raw HTTP so we can set any Host header. */
function http(port: number, method: string, path: string, opts: { body?: unknown; token?: string; host?: string; type?: string } = {}): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request({ host: '127.0.0.1', port, method, path, headers: {
      host: opts.host ?? `127.0.0.1:${port}`,
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(data ? { 'content-type': opts.type ?? 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
    } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(text); } catch { /* html */ }
        resolve({ status: res.statusCode ?? 0, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('remote server', () => {
  let dir = '';
  let family: Family;
  let server: RemoteServer;
  const asked: Array<{ text: string; actor: Actor }> = [];
  const approvals: Array<{ id: string; actor: Actor }> = [];
  let quit = 0;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'remote-'));
    family = new Family(join(dir, 'f.json'), 'Sakthi');
    const bot: BotFacade = {
      family,
      handle: async (text, actor) => { asked.push({ text, actor }); return { text: `ok: ${text}`, outcomes: [], offline: false } satisfies Reply; },
      approve: async (id, actor) => { approvals.push({ id, actor }); return { kind: 'done', tool: 't', text: 'done', verified: true } satisfies Outcome; },
      reject: () => ({ kind: 'done', tool: 't', text: 'no', verified: true }),
      stop: () => {},
      state: (a) => ({ you: { name: a.name, role: a.role } }),
      quit: () => { quit++; },
    };
    server = new RemoteServer({ bot, controlToken: 'local-secret-token-1234567890', phonePage: () => '<html>phone</html>' });
    asked.length = 0;
    approvals.length = 0;
  });
  afterEach(async () => {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('control port needs the local key and a local Host name', async () => {
    const port = await server.startControl(0);
    expect((await http(port, 'GET', '/api/state')).status).toBe(401);
    expect((await http(port, 'GET', '/api/state', { token: 'wrong-token-wrong-token-1234' })).status).toBe(401);
    expect((await http(port, 'GET', '/api/state', { token: 'local-secret-token-1234567890', host: 'evil.example.com' })).status).toBe(403);
    const ok = await http(port, 'GET', '/api/state', { token: 'local-secret-token-1234567890' });
    expect(ok.json).toEqual({ you: { name: 'Sakthi', role: 'owner' } });
    expect((await http(port, 'POST', '/api/pair', { body: { code: '1' } })).status).toBe(401); // no pairing on the control port
  });

  it('a paired phone acts as its family member; unpaired phones get nothing', async () => {
    const port = await server.startPhone(0);
    expect((await http(port, 'GET', '/')).text).toContain('phone');
    expect((await http(port, 'POST', '/api/command', { body: { text: 'hi' } })).status).toBe(401);
    const kid = family.addMember('Asha', 'child', owner);
    const { code } = family.startPairing(kid.id, owner);
    const paired = await http(port, 'POST', '/api/pair', { body: { code, name: 'tablet' } });
    expect(paired.json.member).toEqual({ name: 'Asha', role: 'child' });
    const token = String(paired.json.token);
    await http(port, 'POST', '/api/command', { token, body: { text: 'close roblox' } });
    expect(asked[0]).toMatchObject({ text: 'close roblox', actor: { name: 'Asha', role: 'child', via: 'phone' } });
    await http(port, 'POST', '/api/approve', { token, body: { id: 'a1' } });
    expect(approvals[0]?.actor.role).toBe('child'); // the gate (not the server) refuses a child's approval
    expect((await http(port, 'POST', '/api/quit', { token, body: {} })).status).toBe(403);
    expect(quit).toBe(0);
  });

  it('wants JSON, limits size, and slows down code guessing', async () => {
    const port = await server.startPhone(0);
    expect((await http(port, 'POST', '/api/pair', { body: { code: '1' }, type: 'text/plain' })).status).toBe(415);
    expect((await http(port, 'POST', '/api/pair', { body: { code: 'x'.repeat(20_000) } })).status).toBe(413);
    family.startPairing('owner', owner);
    const tries = [];
    for (let i = 0; i < 6; i++) tries.push((await http(port, 'POST', '/api/pair', { body: { code: '999999' } })).status);
    expect(tries.at(-1)).toBe(429);
  });

  it('children only see their own activity', () => {
    const entries = [{ actor: 'Asha', text: 'a' }, { actor: 'Mom', text: 'b' }];
    expect(visibleActivity({ ...owner, name: 'Asha', role: 'child' }, entries)).toEqual([entries[0]]);
    expect(visibleActivity(owner, entries)).toHaveLength(2);
  });
});

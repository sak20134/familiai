// End to end without Electron: the real runtime with a pretend computer, driven by the real
// `familyai` terminal command in a separate process.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProcInfo, System } from '../src/main/desktop/apps';
import { Brain } from '../src/main/agent/brain';
import { Runtime } from '../src/main/runtime';

const CLI = join(__dirname, '..', 'bin', 'cli.mjs');

function cli(home: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, FAMILYAI_HOME: home, NO_COLOR: '1' }, timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

describe('runtime + familyai command', () => {
  let home = '';
  let rt: Runtime;
  let procs: ProcInfo[] = [{ pid: 41, name: 'notepad' }, { pid: 42, name: 'robloxplayerbeta' }];
  const said: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'rt-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ controlPort: 40000 + Math.floor(Math.random() * 20000) }));
    const sys: System = {
      platform: 'linux',
      selfPids: [],
      sleep: async () => {},
      exec: async (file) => ({ stdout: file === 'ps' ? procs.map((p) => `${p.pid} ${p.name}`).join('\n') : '' }),
      kill: async (pid) => { procs = procs.filter((p) => p.pid !== pid); },
    };
    rt = new Runtime({
      dataDir: home,
      ownerName: 'Sakthi',
      cipher: { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' },
      botName: () => 'Milo',
      openExternal: async () => {},
      releaseFocus: async () => {},
      say: (t) => said.push(t),
      changed: () => {},
      phonePage: () => '',
      quit: () => {},
      sys,
      env: {},
      // A brain that is never set up here: these tests use fixed commands only, and must not download.
      brain: new Brain({ dir: join(home, 'models'), fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch }),
    });
    await rt.start();
  });
  afterAll(async () => {
    await rt.shutdown();
    rmSync(home, { recursive: true, force: true });
  });

  it('reports status', async () => {
    const r = await cli(home, 'status');
    expect(r.out).toContain('Milo is running');
    expect(r.out).toMatch(/AI brain/);
  });

  it('a parent sets a limit and closes games from the terminal', async () => {
    expect((await cli(home, 'talk', 'limit', 'gaming', 'to', '1', 'hour')).out).toMatch(/limited to 1 hour a day/);
    expect(rt.screen.rules()[0]?.label).toBe('gaming');
    expect((await cli(home, 'talk', 'close', 'games')).out).toMatch(/Closed robloxplayerbeta/);
    expect(procs.map((p) => p.name)).toEqual(['notepad']);
  });

  it('closing an app waits for approval, then really closes it', async () => {
    const asked = await cli(home, 'talk', 'close notepad');
    expect(asked.out).toMatch(/waiting for an OK|Waiting for your OK/i);
    const id = rt.agent.pending()[0]!.id;
    expect((await cli(home, 'pending')).out).toContain(id);
    expect(procs).toHaveLength(1);
    expect((await cli(home, 'approve', id)).out).toMatch(/Closed notepad/);
    expect(procs).toHaveLength(0);
  });

  it('the stop switch halts everything, and the activity log keeps the story', async () => {
    await cli(home, 'halt');
    expect(rt.gate.stopped).toBe(true);
    expect((await cli(home, 'talk', 'open', 'spotify')).out).toMatch(/stopped/i);
    expect((await cli(home, 'talk', 'resume')).out).toMatch(/Resumed/);
    const texts = rt.log.recent(50).map((e) => e.text).join('\n');
    expect(texts).toMatch(/close_app: Closed notepad/);
    expect(texts).toMatch(/stop switch/);
  });

  it('take-over needs approval, then lets typing run without a new OK, and stop ends it', async () => {
    const r = await rt.handle('take over for 5 minutes', rt.localActor());
    expect(r.outcomes[0]?.kind).toBe('needs_approval');
    await rt.approve((r.outcomes[0] as { id: string }).id, rt.localActor());
    expect(rt.takeover.state().active).toBe(true);
    expect(rt.gate.standing.has('type_text')).toBe(true);
    const typed = await rt.handle('type: hello', rt.localActor());
    expect(typed.outcomes[0]).toMatchObject({ kind: 'done' });
    rt.stop(rt.localActor());
    expect(rt.takeover.state().active).toBe(false);
    expect(rt.gate.standing.has('type_text')).toBe(false);
    await rt.handle('resume', rt.localActor());
  });

  it('stream commands are honest when OBS is not connected, and bans always ask', async () => {
    const r = await rt.handle('switch to BRB', rt.localActor());
    expect(r.outcomes[0]).toMatchObject({ kind: 'failed' });
    expect(r.text).toMatch(/OBS is not connected/);
    rt.gate.setAiMode(true, rt.localActor());
    expect((await rt.handle('ban spammer', rt.localActor())).outcomes[0]?.kind).toBe('needs_approval');
    rt.gate.setAiMode(false, rt.localActor());
  });
});

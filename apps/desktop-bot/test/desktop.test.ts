import { describe, expect, it } from 'vitest';
import { closeApp, runningApps, isProtected, launchName, matchProcesses, normalizeName, openApp, parsePs, parseTasklist, type ProcInfo, type System } from '../src/main/desktop/apps';
import { escapeSendKeys, parseCombo, sendKeysCombo, TakeOver, xdotoolCombo } from '../src/main/desktop/takeover';
import { checkUrl, readPage } from '../src/main/desktop/web';

/** A pretend computer: a process list we control, and a record of every command run. */
function fakeSystem(platform: NodeJS.Platform, procs: ProcInfo[], opts: { survives?: number[]; failOpen?: boolean } = {}) {
  const ran: Array<{ file: string; args: readonly string[]; env?: Record<string, string> }> = [];
  let list = [...procs];
  const sys: System = {
    platform,
    selfPids: [999],
    sleep: async () => {},
    exec: async (file, args, env) => {
      ran.push({ file, args, ...(env ? { env } : {}) });
      if (file === 'tasklist') return { stdout: list.map((p) => `"${p.name}.exe","${p.pid}","Console","1","10 K"`).join('\r\n') };
      if (file === 'ps') return { stdout: list.map((p) => `${p.pid} /usr/bin/${p.name}`).join('\n') };
      if (opts.failOpen) throw new Error('not found');
      if (file === 'powershell' && env?.FAI_APP) list.push({ pid: 500, name: normalizeName(env.FAI_APP) });
      return { stdout: '' };
    },
    kill: async (pid) => {
      if (!opts.survives?.includes(pid)) list = list.filter((p) => p.pid !== pid);
    },
  };
  return { sys, ran };
}

describe('process lists', () => {
  it('reads Windows tasklist and Unix ps output', () => {
    expect(parseTasklist('"Chrome.exe","1234","Console","1","1 K"\r\n"System","4","Services","0","1 K"')).toEqual([{ name: 'chrome', pid: 1234 }, { name: 'system', pid: 4 }]);
    expect(parsePs('  12 /Applications/Spotify.app/Contents/MacOS/Spotify\n 13 bash\n')).toEqual([{ pid: 12, name: 'spotify' }, { pid: 13, name: 'bash' }]);
  });
  it('matches what people say to real process names', () => {
    const procs = [{ pid: 1, name: 'robloxplayerbeta' }, { pid: 2, name: 'winword' }, { pid: 3, name: 'code' }, { pid: 4, name: 'obs64' }];
    expect(matchProcesses('Roblox', procs).map((p) => p.pid)).toEqual([1]);
    expect(matchProcesses('word', procs).map((p) => p.pid)).toEqual([2]);
    expect(matchProcesses('VS Code', procs).map((p) => p.pid)).toEqual([3]);
    expect(matchProcesses('obs', procs).map((p) => p.pid)).toEqual([4]);
    expect(matchProcesses('co', procs)).toEqual([]); // too short to guess
  });
  it('lists only real apps', async () => {
    const { sys } = fakeSystem('linux', [{ pid: 1, name: 'discord' }, { pid: 2, name: 'bash' }, { pid: 3, name: 'systemd-logind' }, { pid: 4, name: 'obs' }, { pid: 5, name: 'family-ai-bot' }]);
    expect(await runningApps({ ...sys, selfName: 'family-ai-bot' })).toEqual(['discord', 'obs']);
    expect((await closeApp('family-ai-bot', { ...sys, selfName: 'family-ai-bot' })).text).toMatch(/not running/);
  });
  it('protects system processes', () => {
    expect(isProtected('explorer.exe')).toBe(true);
    expect(isProtected('Finder')).toBe(true);
    expect(isProtected('chrome')).toBe(false);
  });
});

describe('closing and opening apps', () => {
  it('says "closed" only when the process is really gone', async () => {
    const { sys } = fakeSystem('win32', [{ pid: 10, name: 'chrome' }]);
    expect(await closeApp('chrome', sys)).toEqual({ ok: true, text: 'Closed chrome.', verified: true });
  });
  it('reports an app that refuses to close, and suggests force close', async () => {
    const { sys } = fakeSystem('linux', [{ pid: 10, name: 'gimp' }], { survives: [10] });
    const r = await closeApp('gimp', sys);
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/force close gimp/);
  });
  it('refuses system processes and itself, and says when nothing is running', async () => {
    const { sys } = fakeSystem('win32', [{ pid: 4, name: 'explorer' }, { pid: 999, name: 'electron' }]);
    expect((await closeApp('explorer', sys)).text).toMatch(/part of the system/);
    expect((await closeApp('electron', sys)).text).toMatch(/not running/);
    expect((await closeApp('steam', sys)).text).toMatch(/not running/);
  });
  it('passes app names in an environment variable, never inside a command string', async () => {
    const { sys, ran } = fakeSystem('win32', []);
    const r = await openApp('notepad', sys);
    const ps = ran.find((x) => x.file === 'powershell')!;
    expect(ps.args.join(' ')).not.toContain('notepad');
    expect(ps.env).toEqual({ FAI_APP: 'notepad' });
    expect(r).toMatchObject({ ok: true, verified: true });
  });
  it('rejects names that are not app names', async () => {
    const { sys, ran } = fakeSystem('win32', []);
    expect((await openApp('calc; del C:\\*', sys)).ok).toBe(false);
    expect((await openApp('$(evil)', sys)).ok).toBe(false);
    expect(ran).toHaveLength(0);
  });
  it('says plainly when an app does not exist', async () => {
    const { sys } = fakeSystem('darwin', [], { failOpen: true });
    expect((await openApp('Nope App', sys)).text).toMatch(/couldn't find/);
    expect(launchName('chrome', 'darwin')).toBe('Google Chrome');
  });
});

describe('take-over', () => {
  it('parses shortcuts and maps them per system', () => {
    expect(parseCombo('Ctrl + S')).toEqual({ mods: ['ctrl'], key: 's' });
    expect(parseCombo('alt+tab')).toEqual({ mods: ['alt'], key: 'tab' });
    expect(parseCombo('ctrl+ctrl+s')).toBeNull();
    expect(parseCombo('rm -rf')).toBeNull();
    expect(sendKeysCombo({ mods: ['ctrl'], key: 's' })).toBe('^s');
    expect(sendKeysCombo({ mods: ['alt'], key: 'f4' })).toBe('%{F4}');
    expect(sendKeysCombo({ mods: ['cmd'], key: 's' })).toBe('^s');
    expect(xdotoolCombo({ mods: ['ctrl', 'shift'], key: 'enter' })).toBe('ctrl+shift+Return');
  });
  it('types special characters literally on Windows', () => {
    expect(escapeSendKeys('50% off + {free}')).toBe('50{%} off {+} {{}free{}}');
  });
  it('refuses to type when take-over is off, and ends by itself', async () => {
    let now = 0;
    const ran: string[][] = [];
    const t = new TakeOver({ platform: 'linux', exec: async (f, a) => { ran.push([f, ...a]); return { stdout: '' }; }, now: () => now });
    await expect(t.typeText('hi')).rejects.toThrow(/Take-over is off/);
    t.start(1, 'Mom');
    await t.typeText('hello');
    expect(ran[0]).toEqual(['xdotool', 'type', '--delay', '15', '--', 'hello']);
    now = 61_000;
    expect(t.active()).toBe(false);
    t.stop();
  });
  it('clamps the time to 1..60 minutes', () => {
    const t = new TakeOver({ platform: 'linux', exec: async () => ({ stdout: '' }), now: () => 0 });
    expect(t.start(500, 'x').until).toBe(60 * 60_000);
    expect(t.start(0, 'x').until).toBe(60_000); // the tool turns "not given" into 10 minutes
    t.stop();
  });
});

describe('web reading', () => {
  const resolve = async (h: string) => (h === 'inside.example.com' ? ['192.168.1.5'] : ['93.184.216.34']);
  it('blocks this computer and the home network, including by DNS', async () => {
    await expect(checkUrl('http://localhost:8080', resolve)).rejects.toThrow(/home network/);
    await expect(checkUrl('http://10.0.0.1', resolve)).rejects.toThrow();
    await expect(checkUrl('https://inside.example.com', resolve)).rejects.toThrow(/home network/);
    await expect(checkUrl('file:///etc/passwd', resolve)).rejects.toThrow(/web address/);
    expect((await checkUrl('https://example.com/a', resolve)).hostname).toBe('example.com');
  });
  it('re-checks every redirect and returns plain text', async () => {
    const fetchImpl = (async (u: URL | string) => {
      const url = String(u);
      if (url.endsWith('/go')) return new Response(null, { status: 302, headers: { location: 'https://inside.example.com/' } });
      return new Response('<title>Hi</title><p>Hello <script>x()</script>world</p>', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    await expect(readPage('https://example.com/go', { fetchImpl, resolve })).rejects.toThrow(/home network/);
    const page = await readPage('https://example.com/', { fetchImpl, resolve });
    expect(page.title).toBe('Hi');
    expect(page.text).toContain('Hello');
    expect(page.text).not.toContain('x()');
  });
});

// Seeing, opening and closing apps on Windows, macOS and Linux using only the system's own
// commands (no native add-ons). Commands always get their arguments as a list, never as one
// shell string, so an app name can never smuggle in another command.
// Every close is checked afterwards: the bot only says "closed" when the process is really gone.

import { basename } from 'node:path';
import { fail, ok, type ToolResult } from '../agent/types';

export interface ProcInfo {
  pid: number;
  /** Normalised: lowercase, no folder, no .exe / .app */
  name: string;
}

export type Exec = (file: string, args: readonly string[], env?: Record<string, string>) => Promise<{ stdout: string }>;

export interface System {
  platform: NodeJS.Platform;
  exec: Exec;
  kill(pid: number, force: boolean): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Our own process ids, which we never close. */
  selfPids: readonly number[];
  /** Our own program name (the bot runs as several processes); never listed or closed. */
  selfName?: string;
}

export function normalizeName(raw: string): string {
  const base = raw.trim().split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|app)$/, '').trim();
}

/** `tasklist /fo csv /nh` lines: "chrome.exe","1234","Console","1","120,000 K" */
export function parseTasklist(csv: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m) out.push({ name: normalizeName(m[1]!), pid: Number(m[2]) });
  }
  return out;
}

/** `ps -o pid=,comm=` lines: "  1234 /Applications/Spotify.app/Contents/MacOS/Spotify" */
export function parsePs(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (m) out.push({ pid: Number(m[1]), name: normalizeName(basename(m[2]!)) });
  }
  return out;
}

export async function listProcesses(sys: System): Promise<ProcInfo[]> {
  if (sys.platform === 'win32') return parseTasklist((await sys.exec('tasklist', ['/fo', 'csv', '/nh'])).stdout);
  // On Linux, leave out the kernel's own threads (children of process 2): they are not apps.
  const args = sys.platform === 'darwin' ? ['-axo', 'pid=,comm='] : ['--ppid', '2', '-p', '2', '--deselect', '-o', 'pid=,comm='];
  return parsePs((await sys.exec('ps', args)).stdout);
}

/** What people say -> the process names those apps really run as. */
const PROCESS_ALIASES: Record<string, readonly string[]> = {
  chrome: ['chrome', 'google chrome'],
  'google chrome': ['chrome', 'google chrome'],
  edge: ['msedge', 'microsoft edge'],
  firefox: ['firefox'],
  'vs code': ['code'],
  vscode: ['code'],
  word: ['winword', 'microsoft word'],
  excel: ['excel', 'microsoft excel'],
  powerpoint: ['powerpnt', 'microsoft powerpoint'],
  obs: ['obs64', 'obs', 'obs-studio'],
  steam: ['steam', 'steamwebhelper'],
  roblox: ['robloxplayerbeta', 'roblox'],
  fortnite: ['fortniteclient-win64-shipping', 'fortnitelauncher'],
  valorant: ['valorant-win64-shipping', 'valorant'],
  minecraft: ['minecraft', 'minecraftlauncher', 'minecraft.windows'],
  'epic games': ['epicgameslauncher'],
  'league of legends': ['league of legends', 'leagueclient'],
  discord: ['discord'],
  spotify: ['spotify'],
};

/** Never closed, whatever anyone asks: closing these would crash or lock the computer. */
const PROTECTED = new Set([
  'system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'svchost', 'explorer', 'dwm',
  'fontdrvhost', 'sihost', 'taskhostw', 'ctfmon', 'runtimebroker', 'searchhost', 'startmenuexperiencehost', 'msmpeng', 'securityhealthservice', 'taskmgr',
  'kernel_task', 'launchd', 'windowserver', 'finder', 'dock', 'loginwindow', 'systemuiserver', 'controlcenter',
  'systemd', 'init', 'xorg', 'xwayland', 'gnome-shell', 'plasmashell', 'kwin_x11', 'kwin_wayland', 'pipewire', 'dbus-daemon', 'sshd', 'login',
]);

export const isProtected = (name: string): boolean => PROTECTED.has(normalizeName(name));

export function candidatesFor(query: string): string[] {
  const q = normalizeName(query);
  return [...new Set([q, ...(PROCESS_ALIASES[q] ?? [])])].filter(Boolean);
}

export function matchProcesses(query: string, procs: readonly ProcInfo[]): ProcInfo[] {
  const wanted = candidatesFor(query);
  const squash = (s: string) => s.replace(/[\s._-]+/g, '');
  return procs.filter((p) => wanted.some((w) =>
    p.name === w || squash(p.name) === squash(w) || (w.length >= 4 && p.name.startsWith(w))));
}

export async function closeApp(query: string, sys: System, force = false): Promise<ToolResult> {
  const label = query.trim();
  if (!label) return fail('Which app should I close?');
  const found = matchProcesses(label, await listProcesses(sys)).filter((p) => !sys.selfPids.includes(p.pid) && p.name !== sys.selfName);
  if (found.length === 0) return fail(`${label} is not running.`);
  const guarded = found.find((p) => isProtected(p.name));
  if (guarded) return fail(`${guarded.name} is part of the system. Closing it could crash the computer, so I won't.`);

  for (const p of found) {
    try {
      await sys.kill(p.pid, force);
    } catch {
      // Already gone, or not ours to close. The check below tells the truth either way.
    }
  }
  await sys.sleep(force ? 800 : 1500);
  const pids = new Set(found.map((p) => p.pid));
  const still = (await listProcesses(sys)).filter((p) => pids.has(p.pid));
  if (still.length === 0) return ok(`Closed ${label}.`);
  return force
    ? fail(`${label} is still running after a forced close. It may need admin rights to close.`)
    : fail(`${label} is still open (it may be asking to save something). Say "force close ${label}" to close it without saving.`);
}

/** Friendly names -> what each system needs to start the app. */
const LAUNCH_ALIASES: Record<string, Partial<Record<NodeJS.Platform, string>>> = {
  chrome: { win32: 'chrome', darwin: 'Google Chrome', linux: 'google-chrome' },
  'google chrome': { win32: 'chrome', darwin: 'Google Chrome', linux: 'google-chrome' },
  edge: { win32: 'msedge', darwin: 'Microsoft Edge', linux: 'microsoft-edge' },
  'vs code': { win32: 'code', darwin: 'Visual Studio Code', linux: 'code' },
  vscode: { win32: 'code', darwin: 'Visual Studio Code', linux: 'code' },
  word: { win32: 'winword', darwin: 'Microsoft Word' },
  excel: { win32: 'excel', darwin: 'Microsoft Excel' },
  powerpoint: { win32: 'powerpnt', darwin: 'Microsoft PowerPoint' },
  calculator: { win32: 'calc', darwin: 'Calculator', linux: 'gnome-calculator' },
  notepad: { win32: 'notepad', darwin: 'TextEdit', linux: 'gedit' },
  obs: { win32: 'obs64', darwin: 'OBS', linux: 'obs' },
  'file explorer': { win32: 'explorer', darwin: 'Finder', linux: 'nautilus' },
  files: { win32: 'explorer', darwin: 'Finder', linux: 'nautilus' },
  terminal: { win32: 'wt', darwin: 'Terminal', linux: 'gnome-terminal' },
};

const SAFE_APP_NAME = /^[\p{L}\p{N} ._+-]{1,64}$/u;

export function launchName(app: string, platform: NodeJS.Platform): string {
  const key = app.trim().toLowerCase();
  return LAUNCH_ALIASES[key]?.[platform] ?? app.trim();
}

export async function openApp(app: string, sys: System): Promise<ToolResult> {
  const label = app.trim();
  if (!SAFE_APP_NAME.test(label)) return fail('That does not look like an app name. Use only letters, numbers and spaces.');
  const target = launchName(label, sys.platform);
  try {
    if (sys.platform === 'win32') {
      // The name travels in an environment variable, so PowerShell never parses it as code.
      await sys.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:FAI_APP'], { FAI_APP: target });
    } else if (sys.platform === 'darwin') {
      await sys.exec('open', ['-a', target]);
    } else {
      const bin = target.toLowerCase().replace(/\s+/g, '-');
      await sys.exec('which', [bin]);
      await sys.exec('setsid', ['-f', bin]);
    }
  } catch {
    return fail(`I couldn't find an app called "${label}" on this computer.`);
  }
  await sys.sleep(2500);
  const procs = await listProcesses(sys);
  const running = matchProcesses(label, procs).length > 0 || matchProcesses(target, procs).length > 0;
  return running ? ok(`Opened ${label}.`) : ok(`Asked the computer to open ${label}. I can't see it running yet; it may still be starting.`, false);
}

const HIDDEN = /^(conhost|dllhost|backgroundtaskhost|smartscreen|wmiprvse|audiodg|spoolsv|textinputhost|applicationframehost|systemsettings|bash|zsh|sh|fish|ps|node|sleep|cat|login|sudo|xvfb-run|xvfb|xorg|systemd-.*|dbus-.*|.*-daemon|process_api)$/;

/** Apps a person would call "open": windowed apps on Windows, foreground apps on a Mac. */
export async function runningApps(sys: System, limit = 40): Promise<string[]> {
  const names = new Set<string>();
  try {
    if (sys.platform === 'win32') {
      const out = await sys.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -ExpandProperty ProcessName']);
      for (const n of out.stdout.split(/\r?\n/)) if (n.trim()) names.add(normalizeName(n));
    } else if (sys.platform === 'darwin') {
      const out = await sys.exec('osascript', ['-e', 'tell application "System Events" to get name of every process whose background only is false']);
      for (const n of out.stdout.split(',')) if (n.trim()) names.add(normalizeName(n));
    }
  } catch {
    // fall back to the full process list below
  }
  if (names.size === 0) {
    for (const p of await listProcesses(sys)) {
      if (!isProtected(p.name) && !sys.selfPids.includes(p.pid) && !HIDDEN.test(p.name)) names.add(p.name);
    }
  }
  for (const n of names) if (isProtected(n) || n === sys.selfName) names.delete(n);
  return [...names].sort().slice(0, limit);
}

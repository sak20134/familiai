// Take-over mode: the bot drives the keyboard to do a task for you.
//   - It must be switched on (a high-risk action, so someone always approves it first).
//   - It ends by itself after the time you gave it (default 10 minutes, at most 60).
//   - The stop switch (Ctrl+Alt+S, the Stop button, or saying "stop") ends it at once.
//   - While it is on, the bot glows red so you always know.
// Text travels in an environment variable or an argument list, never inside a script string.

import type { Exec } from './apps';

export interface TakeOverState {
  active: boolean;
  until: number;
  by: string;
}

export interface Combo {
  mods: Array<'ctrl' | 'alt' | 'shift' | 'cmd'>;
  key: string;
}

const MOD_WORDS: Record<string, Combo['mods'][number]> = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', cmd: 'cmd', command: 'cmd', win: 'cmd', super: 'cmd', meta: 'cmd' };
const SPECIAL = ['enter', 'tab', 'esc', 'escape', 'backspace', 'delete', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'space'] as const;
export const MAX_TYPE_CHARS = 2000;

export function parseCombo(raw: string): Combo | null {
  const parts = raw.toLowerCase().replace(/\s+/g, '').split('+').filter(Boolean);
  if (parts.length === 0 || parts.length > 4) return null;
  const key = parts.pop()!;
  const mods: Combo['mods'] = [];
  for (const p of parts) {
    const m = MOD_WORDS[p];
    if (!m || mods.includes(m)) return null;
    mods.push(m);
  }
  const ok = /^[a-z0-9]$/.test(key) || /^f([1-9]|1[0-2])$/.test(key) || (SPECIAL as readonly string[]).includes(key);
  return ok ? { mods, key: key === 'escape' ? 'esc' : key } : null;
}

/** Windows SendKeys treats + ^ % ~ ( ) { } [ ] as commands; wrap each so it is typed as itself. */
export function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/\r?\n/g, '{ENTER}');
}

export function sendKeysCombo(c: Combo): string {
  // SendKeys has no Windows key, and people who say "cmd+s" on Windows mean Ctrl+S.
  const mod = [...new Set(c.mods.map((m) => ({ ctrl: '^', alt: '%', shift: '+', cmd: '^' })[m]))].join('');
  const key = /^[a-z0-9]$/.test(c.key) ? c.key : `{${c.key === 'esc' ? 'ESC' : c.key === 'space' ? ' ' : c.key.toUpperCase()}}`;
  return c.key === 'space' ? `${mod} ` : `${mod}${key}`;
}

const MAC_CODES: Record<string, number> = { enter: 36, tab: 48, esc: 53, backspace: 51, delete: 117, up: 126, down: 125, left: 123, right: 124, home: 115, end: 119, pageup: 116, pagedown: 121, space: 49, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };
const X_NAMES: Record<string, string> = { enter: 'Return', tab: 'Tab', esc: 'Escape', backspace: 'BackSpace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', space: 'space' };

export function xdotoolCombo(c: Combo): string {
  const mods = c.mods.map((m) => ({ ctrl: 'ctrl', alt: 'alt', shift: 'shift', cmd: 'super' })[m]);
  return [...mods, X_NAMES[c.key] ?? (c.key.startsWith('f') && c.key.length > 1 ? c.key.toUpperCase() : c.key)].join('+');
}

export interface TakeOverOptions {
  platform: NodeJS.Platform;
  exec: Exec;
  now?: () => number;
  /** Moves keyboard focus away from the bot so keys land in the app underneath. */
  releaseFocus?: () => Promise<void>;
  onChange?: (state: TakeOverState) => void;
}

export class TakeOver {
  private until = 0;
  private by = '';
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly o: TakeOverOptions) {
    this.now = o.now ?? Date.now;
  }

  state(): TakeOverState {
    return { active: this.active(), until: this.until, by: this.by };
  }

  active(): boolean {
    if (this.until !== 0 && this.now() >= this.until) this.stop();
    return this.until !== 0;
  }

  start(minutes: number, by: string): TakeOverState {
    const m = Math.min(60, Math.max(1, Math.round(Number.isFinite(minutes) ? minutes : 10)));
    this.until = this.now() + m * 60_000;
    this.by = by;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop(), m * 60_000);
    this.timer.unref?.();
    this.o.onChange?.(this.state());
    return this.state();
  }

  stop(): void {
    const was = this.until !== 0;
    this.until = 0;
    this.by = '';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (was) this.o.onChange?.(this.state());
  }

  async typeText(text: string): Promise<void> {
    this.mustBeActive();
    const t = text.slice(0, MAX_TYPE_CHARS);
    if (!t) throw new Error('There is nothing to type.');
    await this.o.releaseFocus?.();
    if (this.o.platform === 'win32') {
      await this.o.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($env:FAI_KEYS)'], { FAI_KEYS: escapeSendKeys(t) });
    } else if (this.o.platform === 'darwin') {
      await this.o.exec('osascript', ['-e', 'on run argv', '-e', 'tell application "System Events" to keystroke (item 1 of argv)', '-e', 'end run', t]);
    } else {
      await this.o.exec('xdotool', ['type', '--delay', '15', '--', t]);
    }
  }

  async pressKeys(raw: string): Promise<Combo> {
    this.mustBeActive();
    const c = parseCombo(raw);
    if (!c) throw new Error(`I don't know the keys "${raw}". Try ctrl+s, alt+tab, enter or f5.`);
    await this.o.releaseFocus?.();
    if (this.o.platform === 'win32') {
      await this.o.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($env:FAI_KEYS)'], { FAI_KEYS: sendKeysCombo(c) });
    } else if (this.o.platform === 'darwin') {
      const using = c.mods.map((m) => ({ ctrl: 'control down', alt: 'option down', shift: 'shift down', cmd: 'command down' })[m]).join(', ');
      const code = MAC_CODES[c.key];
      const action = code !== undefined ? `key code ${code}` : 'keystroke (item 1 of argv)';
      const script = `tell application "System Events" to ${action}${using ? ` using {${using}}` : ''}`;
      await this.o.exec('osascript', ['-e', 'on run argv', '-e', script, '-e', 'end run', c.key]);
    } else {
      await this.o.exec('xdotool', ['key', '--clearmodifiers', xdotoolCombo(c)]);
    }
    return c;
  }

  private mustBeActive(): void {
    if (!this.active()) throw new Error('Take-over is off. Ask me to "take over" first, and someone will need to approve it.');
  }
}

// Screen-time limits set by a parent ("limit gaming to 1 hour a day").
// Every half minute the bot looks at what is running and counts time for each limit. It warns
// at 5 minutes and 1 minute left; at the limit it closes those apps (and keeps closing them if
// they are opened again that day). Time resets at local midnight.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { matchProcesses, type ProcInfo } from '../desktop/apps';

export interface LimitRule {
  id: string;
  /** What the parent said: "gaming", "minecraft", "youtube". */
  label: string;
  /** App names this limit covers. */
  apps: string[];
  dailyMinutes: number;
  createdBy: string;
  createdAt: number;
}

export type ScreenEvent =
  | { kind: 'warn'; rule: LimitRule; leftMinutes: number }
  | { kind: 'limit'; rule: LimitRule; running: ProcInfo[] };

interface Saved {
  rules: LimitRule[];
  day: string;
  usedMs: Record<string, number>;
  warned: Record<string, number[]>;
}

/** Common games and game launchers. "gaming" and "games" mean all of these. */
export const GAME_APPS: readonly string[] = [
  'robloxplayerbeta', 'fortniteclient-win64-shipping', 'valorant-win64-shipping', 'minecraft', 'minecraftlauncher', 'minecraft.windows',
  'leagueclient', 'league of legends', 'cs2', 'csgo', 'gta5', 'rocketleague', 'genshinimpact', 'overwatch', 'r5apex', 'eldenring',
  'fc25', 'fc26', 'pubg', 'tslgame', 'brawlhalla', 'among us', 'terraria', 'dota2', 'steam', 'steamwebhelper', 'epicgameslauncher',
  'battle.net', 'riotclientservices', 'xboxapp', 'gamebar',
];

const WARN_AT = [5, 1] as const;
const MAX_TICK_MS = 2 * 60_000; // a computer waking from sleep must not count the sleep as play

export function appsForLabel(label: string): string[] {
  const l = label.trim().toLowerCase();
  if (/^(gaming|games?|video ?games?|all games)$/.test(l)) return [...GAME_APPS];
  return [l];
}

export function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class ScreenTime {
  private data: Saved;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(file), { recursive: true });
    this.data = this.read();
  }

  rules(): LimitRule[] {
    return this.data.rules.map((r) => ({ ...r, apps: [...r.apps] }));
  }

  setLimit(label: string, minutes: number, by: string): LimitRule {
    const clean = label.trim().slice(0, 40);
    if (!clean) throw new Error('Which app or activity should I limit?');
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new Error('The limit must be between 1 minute and 24 hours a day.');
    const existing = this.data.rules.find((r) => r.label.toLowerCase() === clean.toLowerCase());
    const rule: LimitRule = {
      id: existing?.id ?? `lim${this.now().toString(36)}`,
      label: clean,
      apps: appsForLabel(clean),
      dailyMinutes: Math.round(minutes),
      createdBy: by,
      createdAt: this.now(),
    };
    this.data.rules = [...this.data.rules.filter((r) => r.id !== rule.id), rule];
    if (this.data.warned[rule.id]) delete this.data.warned[rule.id];
    this.save();
    return rule;
  }

  removeLimit(label: string): LimitRule | null {
    const l = label.trim().toLowerCase();
    const rule = this.data.rules.find((r) => r.label.toLowerCase() === l || r.id === l);
    if (!rule) return null;
    this.data.rules = this.data.rules.filter((r) => r.id !== rule.id);
    this.save();
    return rule;
  }

  status(): Array<{ rule: LimitRule; usedMinutes: number; leftMinutes: number }> {
    this.rollDay();
    return this.data.rules.map((rule) => {
      const used = Math.floor((this.data.usedMs[rule.id] ?? 0) / 60_000);
      return { rule, usedMinutes: used, leftMinutes: Math.max(0, rule.dailyMinutes - used) };
    });
  }

  /** Call regularly with what is running and how long since the last call. */
  tick(procs: readonly ProcInfo[], elapsedMs: number): ScreenEvent[] {
    this.rollDay();
    const step = Math.max(0, Math.min(elapsedMs, MAX_TICK_MS));
    const events: ScreenEvent[] = [];
    let changed = false;
    for (const rule of this.data.rules) {
      const running = procs.filter((p) => rule.apps.some((a) => matchProcesses(a, [p]).length > 0));
      if (running.length === 0) continue;
      const used = (this.data.usedMs[rule.id] ?? 0) + step;
      this.data.usedMs[rule.id] = used;
      changed = true;
      const leftMs = rule.dailyMinutes * 60_000 - used;
      if (leftMs <= 0) {
        events.push({ kind: 'limit', rule, running });
        continue;
      }
      const warned = (this.data.warned[rule.id] ??= []);
      for (const w of WARN_AT) {
        if (leftMs <= w * 60_000 && !warned.includes(w)) {
          warned.push(w);
          events.push({ kind: 'warn', rule, leftMinutes: w });
          break;
        }
      }
    }
    if (changed) this.save();
    return events;
  }

  private rollDay(): void {
    const today = dayKey(this.now());
    if (this.data.day === today) return;
    this.data.day = today;
    this.data.usedMs = {};
    this.data.warned = {};
    this.save();
  }

  private read(): Saved {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>;
      return {
        rules: Array.isArray(raw.rules) ? raw.rules.filter((r) => r && typeof r.label === 'string' && Array.isArray(r.apps)) : [],
        day: typeof raw.day === 'string' ? raw.day : dayKey(this.now()),
        usedMs: raw.usedMs && typeof raw.usedMs === 'object' ? raw.usedMs : {},
        warned: raw.warned && typeof raw.warned === 'object' ? raw.warned : {},
      };
    } catch {
      return { rules: [], day: dayKey(this.now()), usedMs: {}, warned: {} };
    }
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
    renameSync(tmp, this.file);
  }
}

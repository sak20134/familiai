// Saves the bot's look and options in a small JSON file in the app's data folder.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotSettings } from '../shared/api';

export const DEFAULT_SETTINGS: BotSettings = { botName: 'Buddy', imagePath: null, quiet: false };

/** Accepts anything read from disk and returns safe settings. Bad fields fall back to defaults. */
export function parseSettings(raw: unknown): BotSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const name = typeof o.botName === 'string' ? o.botName.trim().slice(0, 30) : '';
  return {
    botName: name || DEFAULT_SETTINGS.botName,
    imagePath: typeof o.imagePath === 'string' && o.imagePath !== '' ? o.imagePath : null,
    quiet: o.quiet === true,
  };
}

export class SettingsStore {
  private readonly file: string;
  private current: BotSettings;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'settings.json');
    this.current = this.read();
  }

  get(): BotSettings {
    return { ...this.current };
  }

  update(patch: Partial<BotSettings>): BotSettings {
    this.current = parseSettings({ ...this.current, ...patch });
    // Write to a temp file then rename, so a crash never leaves a half-written file.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.current, null, 2), 'utf8');
    renameSync(tmp, this.file);
    return this.get();
  }

  private read(): BotSettings {
    try {
      return parseSettings(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
}

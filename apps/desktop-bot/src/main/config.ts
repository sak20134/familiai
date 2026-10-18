// The bot's settings beyond its look: which AI to use, stream connections, phone control.
// Secrets (Claude key, Twitch token, OBS password) are encrypted with the operating system's
// own secure storage (Windows DPAPI, macOS Keychain, Linux secret service) and never shown
// back to the screen: the page only learns whether each one is set.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderName } from './agent/model';

export interface BotConfig {
  provider: ProviderName | 'none';
  model: string;
  ollamaUrl: string;
  obsUrl: string;
  twitchClientId: string;
  twitchChannel: string;
  phoneControl: boolean;
  phonePort: number;
  controlPort: number;
  speakReplies: boolean;
  autoConnectStream: boolean;
}

export const SECRET_NAMES = ['anthropicKey', 'twitchToken', 'obsPassword'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export const DEFAULT_CONFIG: BotConfig = {
  // The bot's own brain, running inside the bot. Claude and Ollama are optional extras.
  provider: 'builtin',
  model: '',
  ollamaUrl: 'http://127.0.0.1:11434',
  obsUrl: 'ws://127.0.0.1:4455',
  twitchClientId: '',
  twitchChannel: '',
  phoneControl: false,
  phonePort: 47778,
  controlPort: 47777,
  speakReplies: false,
  autoConnectStream: false,
};

export interface Cipher {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

const s = (v: unknown, max: number, fallback: string) => (typeof v === 'string' ? v.trim().slice(0, max) : fallback);
const port = (v: unknown, fallback: number) => (Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535 ? (v as number) : fallback);

/** Anything from disk or from the page goes through here; unknown or bad fields fall back. */
export function parseConfig(raw: unknown): BotConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const provider = o.provider === 'anthropic' || o.provider === 'ollama' || o.provider === 'none' ? o.provider : 'builtin';
  const ollamaUrl = s(o.ollamaUrl, 200, DEFAULT_CONFIG.ollamaUrl);
  const obsUrl = s(o.obsUrl, 200, DEFAULT_CONFIG.obsUrl);
  return {
    provider,
    model: s(o.model, 80, '').replace(/[^\w.:/-]/g, ''),
    ollamaUrl: /^https?:\/\/[^\s]+$/.test(ollamaUrl) ? ollamaUrl : DEFAULT_CONFIG.ollamaUrl,
    obsUrl: /^wss?:\/\/[^\s]+$/.test(obsUrl) ? obsUrl : DEFAULT_CONFIG.obsUrl,
    twitchClientId: s(o.twitchClientId, 64, '').replace(/[^\w]/g, ''),
    twitchChannel: s(o.twitchChannel, 40, '').replace(/^#/, '').replace(/[^\w]/g, '').toLowerCase(),
    phoneControl: o.phoneControl === true,
    phonePort: port(o.phonePort, DEFAULT_CONFIG.phonePort),
    controlPort: port(o.controlPort, DEFAULT_CONFIG.controlPort),
    speakReplies: o.speakReplies === true,
    autoConnectStream: o.autoConnectStream === true,
  };
}

export class ConfigStore {
  private readonly file: string;
  private readonly secretsFile: string;
  private current: BotConfig;
  private secrets: Partial<Record<SecretName, string>> = {};

  constructor(dir: string, private readonly cipher: Cipher) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'config.json');
    this.secretsFile = join(dir, 'secrets.bin');
    this.current = this.readConfig();
    this.secrets = this.readSecrets();
  }

  get(): BotConfig {
    return { ...this.current };
  }

  update(patch: Partial<BotConfig>): BotConfig {
    this.current = parseConfig({ ...this.current, ...patch });
    atomicWrite(this.file, JSON.stringify(this.current, null, 2));
    return this.get();
  }

  secret(name: SecretName): string | undefined {
    return this.secrets[name];
  }

  /** Which secrets are set, without their values. */
  secretFlags(): Record<SecretName, boolean> {
    return { anthropicKey: Boolean(this.secrets.anthropicKey), twitchToken: Boolean(this.secrets.twitchToken), obsPassword: Boolean(this.secrets.obsPassword) };
  }

  /** An empty value removes the secret. */
  setSecret(name: SecretName, value: string): void {
    if (!SECRET_NAMES.includes(name)) throw new Error('Unknown setting.');
    if (!this.cipher.available()) throw new Error('This computer has no secure storage available, so I will not save keys. Put them in the .env file instead.');
    const v = value.trim().slice(0, 400);
    if (v) this.secrets[name] = v;
    else delete this.secrets[name];
    atomicWrite(this.secretsFile, this.cipher.encrypt(JSON.stringify(this.secrets)));
  }

  private readConfig(): BotConfig {
    try {
      return parseConfig(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private readSecrets(): Partial<Record<SecretName, string>> {
    try {
      if (!this.cipher.available()) return {};
      const raw = JSON.parse(this.cipher.decrypt(readFileSync(this.secretsFile))) as Record<string, unknown>;
      const out: Partial<Record<SecretName, string>> = {};
      for (const k of SECRET_NAMES) if (typeof raw[k] === 'string' && raw[k]) out[k] = raw[k] as string;
      return out;
    } catch {
      return {};
    }
  }
}

function atomicWrite(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

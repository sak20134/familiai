// Types shared by the main process, the preload bridge and the bot window. Types only: no code.
// (Kept free of imports so the window's code never pulls in Node-only modules.)

export interface BotSettings {
  botName: string;
  /** Absolute path of the chosen bot image inside the app's data folder, or null for the built-in cat. */
  imagePath: string | null;
  quiet: boolean;
}

export interface ViewSettings extends BotSettings {
  /** file:// URL the window can show, or null for the built-in cat. */
  imageUrl: string | null;
}

export interface ImageResult {
  id: string;
  title: string;
  thumbnail: string;
  license: string;
  licenseUrl: string | null;
  creator: string | null;
  pageUrl: string | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type Role = 'owner' | 'admin' | 'adult' | 'teen' | 'child' | 'elder' | 'guest';

export type OutcomeView =
  | { kind: 'done'; tool: string; text: string; verified: boolean }
  | { kind: 'needs_approval'; tool: string; id: string; summary: string }
  | { kind: 'blocked'; tool: string; text: string }
  | { kind: 'failed'; tool: string; text: string };

export interface ReplyView {
  text: string;
  outcomes: OutcomeView[];
  offline: boolean;
}

export interface PendingItem {
  id: string;
  summary: string;
  risk: string;
  requestedBy: string;
  createdAt: number;
}

export interface LinkView {
  state: 'off' | 'connecting' | 'connected' | 'error';
  detail: string;
}

export interface ConfigView {
  provider: 'builtin' | 'anthropic' | 'ollama' | 'none';
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

export type SecretName = 'anthropicKey' | 'twitchToken' | 'obsPassword';

export interface BotState {
  settings: ViewSettings;
  config: ConfigView;
  secrets: Record<SecretName, boolean>;
  secureStorage: boolean;
  botName: string;
  you: { name: string; role: Role };
  canApprove: boolean;
  canManage: boolean;
  modelReady: boolean;
  brain: { state: 'missing' | 'downloading' | 'asleep' | 'loading' | 'ready' | 'error'; detail: string; progress?: number };
  aiMode: boolean;
  stopped: boolean;
  takeover: { active: boolean; until: number; by: string };
  pending: PendingItem[];
  limits: Array<{ id: string; label: string; dailyMinutes: number; usedMinutes: number; leftMinutes: number }>;
  stream: { obs: LinkView; twitch: LinkView; poll: string | null; giveaway: string | null };
  members: Array<{ id: string; name: string; role: Role }>;
  devices: Array<{ id: string; name: string; memberName: string; lastSeen: number }>;
  phone: { running: boolean; urls: string[]; error: string | null; pairing: { code: string; expiresAt: number; member: string } | null };
  activity: Array<{ at: number; kind: string; status: string; actor: string; text: string }>;
}

export type BotEvent =
  | { type: 'say'; text: string }
  | { type: 'state' };

export interface BotApi {
  getState(): Promise<BotState>;
  ask(text: string): Promise<Result<ReplyView>>;
  approve(id: string): Promise<Result<OutcomeView>>;
  reject(id: string): Promise<Result<OutcomeView>>;
  stop(): void;
  setAiMode(on: boolean): Promise<Result<BotState>>;
  updateConfig(patch: Partial<ConfigView>): Promise<Result<BotState>>;
  setSecret(name: SecretName, value: string): Promise<Result<BotState>>;
  connectStream(): Promise<Result<BotState>>;
  addMember(name: string, role: Role): Promise<Result<BotState>>;
  removeMember(id: string): Promise<Result<BotState>>;
  startPairing(memberId: string): Promise<Result<BotState>>;
  cancelPairing(): Promise<Result<BotState>>;
  revokeDevice(id: string): Promise<Result<BotState>>;
  setBotName(name: string): Promise<Result<BotState>>;
  pickImage(): Promise<Result<BotState>>;
  searchImages(query: string): Promise<Result<ImageResult[]>>;
  useSearchImage(image: ImageResult): Promise<Result<BotState>>;
  saveProcessedImage(pngDataUrl: string): Promise<Result<BotState>>;
  resetImage(): Promise<Result<BotState>>;
  setQuiet(quiet: boolean): Promise<Result<BotState>>;
  /** Tell the window whether the mouse is over something clickable (otherwise clicks pass through). */
  setInteractive(interactive: boolean): void;
  /** Grow the window while a panel is open, shrink it back when closed. */
  setExpanded(expanded: boolean): void;
  onEvent(listener: (e: BotEvent) => void): void;
  quit(): void;
}

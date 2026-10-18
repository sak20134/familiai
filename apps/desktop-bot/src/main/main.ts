// Electron main process: the floating window, the stop shortcut, and the bridge between the
// window and the bot's runtime. Everything that touches files, apps or the network is here or
// in the runtime, never in the window.

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, safeStorage, screen, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BotEvent, BotState, ImageResult, Result, Role, SecretName } from '../shared/api';
import type { Cipher } from './config';
import { parseEnv } from './env';
import { fileNameFor, isAllowedDownloadUrl, MAX_IMAGE_BYTES, pngDataUrlToBuffer, validateImage } from './images';
import { cleanQuery, searchImages } from './openverse';
import { Runtime } from './runtime';
import { SettingsStore } from './settings';

// Tall enough for an approval card and a speech bubble; the empty part lets clicks through.
const COMPACT = { w: 300, h: 430 };
const EXPANDED = { w: 420, h: 680 };
const STOP_SHORTCUT = 'CommandOrControl+Alt+S';

// One fixed home for the bot's data, like Ollama's ~/.ollama, so the terminal command finds it.
app.setPath('userData', process.env.FAMILYAI_HOME || join(homedir(), '.familyai'));

let win: BrowserWindow | null = null;
let store: SettingsStore;
let runtime: Runtime;
let botsDir: string;
let pairing: BotState['phone']['pairing'] = null;

function loadEnvFile(): void {
  for (const dir of [app.getAppPath(), app.getPath('userData')]) {
    try {
      const file = join(dir, '.env');
      if (!existsSync(file)) continue;
      for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) if (process.env[k] === undefined) process.env[k] = v;
    } catch {
      // A broken .env just means no keys from it.
    }
  }
}

const cipher: Cipher = {
  // On Linux without a keyring Electron falls back to plain text; that does not count as secure.
  available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (t) => safeStorage.encryptString(t),
  decrypt: (b) => safeStorage.decryptString(b),
};

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: unknown): Result<never> => ({ ok: false, error: error instanceof Error ? error.message : String(error) });

function emit(e: BotEvent): void {
  win?.webContents.send('bot:event', e);
}

function state(): BotState {
  const local = runtime.localActor();
  const s = store.get();
  const base = runtime.state(local) as unknown as BotState;
  if (pairing && Date.now() > pairing.expiresAt) pairing = null;
  return {
    ...base,
    settings: { ...s, imageUrl: s.imagePath && existsSync(s.imagePath) ? pathToFileURL(s.imagePath).href : null },
    config: runtime.config.get(),
    secrets: runtime.config.secretFlags(),
    secureStorage: cipher.available(),
    phone: { ...base.phone, pairing: runtime.family.pairingActive() ? pairing : null },
  };
}

function saveImageBytes(bytes: Buffer): Result<BotState> {
  const check = validateImage(bytes);
  if (!check.ok) return fail(check.error);
  mkdirSync(botsDir, { recursive: true });
  const target = join(botsDir, fileNameFor(bytes, check.type));
  writeFileSync(target, bytes);
  store.update({ imagePath: target });
  return ok(state());
}

function placeWindow(size: { w: number; h: number }): void {
  if (!win) return;
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const b = win.getBounds();
  // Keep the bottom-right corner where it is, so the bot does not jump when a panel opens.
  const right = Math.min(b.x + b.width, workArea.x + workArea.width);
  const bottom = Math.min(b.y + b.height, workArea.y + workArea.height);
  win.setBounds({ x: Math.max(workArea.x, right - size.w), y: Math.max(workArea.y, bottom - size.h), width: size.w, height: size.h });
}

function createWindow(): void {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: COMPACT.w,
    height: COMPACT.h,
    x: workArea.x + workArea.width - COMPACT.w - 16,
    y: workArea.y + workArea.height - COMPACT.h - 8,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { preload: join(__dirname, '../preload/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('closed', () => { win = null; });
}

/** Hands the keyboard to the app underneath before take-over types anything. */
async function releaseFocus(): Promise<void> {
  if (!win) return;
  win.blur();
  if (process.platform === 'darwin') app.hide();
  await new Promise((r) => setTimeout(r, 250));
  win?.showInactive();
}

type Handler = (...args: unknown[]) => unknown;
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      return fail(err);
    }
  });
}

function registerIpc(): void {
  const me = () => runtime.localActor();
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  handle('state:get', () => state());
  handle('bot:ask', async (text) => ok(await runtime.handle(str(text), me())));
  handle('bot:approve', async (id) => ok(await runtime.approve(str(id), me())));
  handle('bot:reject', (id) => ok(runtime.reject(str(id), me())));
  ipcMain.on('bot:stop', () => runtime.stop(me()));
  handle('bot:ai-mode', (on) => {
    if (!runtime.gate.setAiMode(on === true, me())) return fail('You cannot turn on AI Mode.');
    runtime.log.add('safety', 'done', me().name, `AI Mode ${on === true ? 'on' : 'off'}.`);
    return ok(state());
  });

  handle('config:update', async (patch) => {
    const before = runtime.config.get();
    const after = runtime.config.update((patch && typeof patch === 'object' ? patch : {}) as object);
    if (before.phoneControl !== after.phoneControl || (after.phoneControl && before.phonePort !== after.phonePort)) await runtime.setPhoneControl(after.phoneControl);
    return ok(state());
  });
  handle('config:secret', (name, value) => {
    runtime.config.setSecret(str(name) as SecretName, str(value));
    return ok(state());
  });
  handle('stream:connect', async () => {
    await runtime.connectStream();
    return ok(state());
  });

  handle('family:add', (name, role) => {
    const m = runtime.family.addMember(str(name), str(role) as Role, me());
    runtime.log.add('safety', 'done', me().name, `Added ${m.name} to the family as ${m.role}.`);
    return ok(state());
  });
  handle('family:remove', (id) => {
    const m = runtime.family.removeMember(str(id), me());
    runtime.log.add('safety', 'done', me().name, `Removed ${m.name} from the family and unpaired their phones.`);
    return ok(state());
  });
  handle('family:pair', (memberId) => {
    if (!runtime.remote.phoneRunning()) return fail('Turn on Phone control first.');
    pairing = runtime.family.startPairing(str(memberId), me());
    return ok(state());
  });
  handle('family:cancel-pair', () => {
    runtime.family.cancelPairing();
    pairing = null;
    return ok(state());
  });
  handle('family:revoke', (id) => {
    runtime.family.revokeDevice(str(id), me());
    return ok(state());
  });

  handle('look:name', (name) => {
    store.update({ botName: str(name) });
    return ok(state());
  });
  handle('image:pick', async () => {
    if (!win) return fail('The window is not ready.');
    const picked = await dialog.showOpenDialog(win, { title: 'Choose an image for your bot', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'gif', 'jpg', 'jpeg', 'webp'] }] });
    const file = picked.filePaths[0];
    if (picked.canceled || !file) return ok(state());
    return saveImageBytes(readFileSync(file));
  });
  handle('image:search', async (raw) => {
    const q = cleanQuery(str(raw));
    if (!q) return fail('Type 2 to 80 letters to search.');
    return ok(await searchImages(q));
  });
  handle('image:use-search', async (raw) => {
    const url = (raw as Partial<ImageResult> | null)?.thumbnail;
    if (typeof url !== 'string' || !isAllowedDownloadUrl(url)) return fail('That image link is not allowed.');
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return fail(`Could not download the image (${res.status}).`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return fail('The image is bigger than 5 MB.');
    return saveImageBytes(bytes);
  });
  handle('image:save-processed', (raw) => {
    const bytes = pngDataUrlToBuffer(str(raw));
    return bytes ? saveImageBytes(bytes) : fail('That was not a valid PNG image.');
  });
  handle('image:reset', () => {
    store.update({ imagePath: null });
    return ok(state());
  });
  handle('quiet:set', (q) => {
    store.update({ quiet: q === true });
    return ok(state());
  });

  ipcMain.on('window:interactive', (_e, interactive: unknown) => {
    if (!win) return;
    if (interactive === true) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  });
  ipcMain.on('window:expanded', (_e, expanded: unknown) => placeWindow(expanded === true ? EXPANDED : COMPACT));
  ipcMain.on('app:quit', () => app.quit());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    loadEnvFile();
    const data = app.getPath('userData');
    store = new SettingsStore(data);
    botsDir = join(data, 'bots');
    runtime = new Runtime({
      dataDir: data,
      ownerName: (() => {
        try {
          const n = userInfo().username;
          return n.charAt(0).toUpperCase() + n.slice(1);
        } catch {
          return 'Owner';
        }
      })(),
      cipher,
      botName: () => store.get().botName,
      openExternal: (url) => shell.openExternal(url),
      releaseFocus,
      say: (text) => emit({ type: 'say', text }),
      changed: () => emit({ type: 'state' }),
      phonePage: () => readFileSync(join(__dirname, '../remote/remote.html'), 'utf8'),
      quit: () => app.quit(),
    });
    registerIpc();
    createWindow();
    await runtime.start();
    // The stop switch works from anywhere, even when the bot's window is hidden or behind a game.
    if (!globalShortcut.register(STOP_SHORTCUT, () => runtime.stop(runtime.localActor()))) {
      runtime.log.add('safety', 'failed', 'Bot', `Could not register the ${STOP_SHORTCUT} stop shortcut (another app uses it). The Stop button still works.`);
    }
  });
  app.on('second-instance', () => {
    win?.showInactive();
    emit({ type: 'say', text: "I'm already here!" });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => void runtime?.shutdown());
  app.on('window-all-closed', () => app.quit());
}

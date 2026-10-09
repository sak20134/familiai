// Electron main process: the floating window and everything that touches files or the network.

import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChatReply, ImageResult, Result, ViewSettings } from '../shared/api';
import { reply as chatReply, MAX_MESSAGE_CHARS, type Turn } from './chat';
import { parseEnv } from './env';
import { fileNameFor, isAllowedDownloadUrl, MAX_IMAGE_BYTES, pngDataUrlToBuffer, validateImage } from './images';
import { cleanQuery, searchImages } from './openverse';
import { SettingsStore } from './settings';

const WINDOW_W = 360;
const WINDOW_H = 560;

let win: BrowserWindow | null = null;
let store: SettingsStore;
let botsDir: string;
const history: Turn[] = [];

function loadEnvFile(): void {
  try {
    const file = join(app.getAppPath(), '.env');
    if (!existsSync(file)) return;
    for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // A broken .env just means demo mode.
  }
}

function view(): ViewSettings {
  const s = store.get();
  const imageUrl = s.imagePath && existsSync(s.imagePath) ? pathToFileURL(s.imagePath).href : null;
  return { ...s, imageUrl, hasModelKey: Boolean(process.env.ANTHROPIC_API_KEY) };
}

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: unknown): Result<never> => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});

function saveImageBytes(bytes: Buffer): Result<ViewSettings> {
  const check = validateImage(bytes);
  if (!check.ok) return fail(check.error);
  mkdirSync(botsDir, { recursive: true });
  const target = join(botsDir, fileNameFor(bytes, check.type));
  writeFileSync(target, bytes);
  store.update({ imagePath: target });
  return ok(view());
}

function createWindow(): void {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WINDOW_W,
    height: WINDOW_H,
    x: workArea.x + workArea.width - WINDOW_W - 16,
    y: workArea.y + workArea.height - WINDOW_H - 8,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  // Clicks pass through the transparent parts until the mouse is over the bot or a panel.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(join(__dirname, '../renderer/index.html'));
  win.on('closed', () => { win = null; });
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => view());

  ipcMain.handle('image:pick', async (): Promise<Result<ViewSettings>> => {
    try {
      if (!win) return fail('The window is not ready.');
      const picked = await dialog.showOpenDialog(win, {
        title: 'Choose an image for your bot',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'gif', 'jpg', 'jpeg', 'webp'] }],
      });
      const file = picked.filePaths[0];
      if (picked.canceled || !file) return ok(view());
      return saveImageBytes(readFileSync(file));
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('image:search', async (_e, raw: unknown): Promise<Result<ImageResult[]>> => {
    try {
      const q = typeof raw === 'string' ? cleanQuery(raw) : null;
      if (!q) return fail('Type 2 to 80 letters to search.');
      return ok(await searchImages(q));
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('image:use-search', async (_e, raw: unknown): Promise<Result<ViewSettings>> => {
    try {
      const url = (raw as { thumbnail?: unknown } | null)?.thumbnail;
      if (typeof url !== 'string' || !isAllowedDownloadUrl(url)) return fail('That image link is not allowed.');
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return fail(`Could not download the image (${res.status}).`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES) return fail('The image is bigger than 5 MB.');
      return saveImageBytes(bytes);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('image:save-processed', (_e, raw: unknown): Result<ViewSettings> => {
    try {
      const bytes = typeof raw === 'string' ? pngDataUrlToBuffer(raw) : null;
      if (!bytes) return fail('That was not a valid PNG image.');
      return saveImageBytes(bytes);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('image:reset', (): Result<ViewSettings> => {
    store.update({ imagePath: null });
    return ok(view());
  });

  ipcMain.handle('quiet:set', (_e, raw: unknown): Result<ViewSettings> => {
    store.update({ quiet: raw === true });
    return ok(view());
  });

  ipcMain.handle('chat:send', async (_e, raw: unknown): Promise<Result<ChatReply>> => {
    try {
      if (typeof raw !== 'string') return fail('Type something first.');
      const message = raw.trim().slice(0, MAX_MESSAGE_CHARS);
      const result = await chatReply({
        message,
        history,
        botName: store.get().botName,
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: process.env.FAMILYAI_MODEL || 'claude-sonnet-5-5',
      });
      if (!result.demo) {
        history.push({ role: 'user', content: message }, { role: 'assistant', content: result.text });
        if (history.length > 20) history.splice(0, history.length - 20);
      }
      return ok(result);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.on('window:interactive', (_e, interactive: unknown) => {
    if (!win) return;
    if (interactive === true) win.setIgnoreMouseEvents(false);
    else win.setIgnoreMouseEvents(true, { forward: true });
  });

  ipcMain.on('app:quit', () => app.quit());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    loadEnvFile();
    store = new SettingsStore(app.getPath('userData'));
    botsDir = join(app.getPath('userData'), 'bots');
    registerIpc();
    createWindow();
  });
  app.on('second-instance', () => win?.show());
  app.on('window-all-closed', () => app.quit());
}

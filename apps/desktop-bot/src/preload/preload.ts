// The only bridge between the page and the main process. Exposes a small, fixed set of actions.
// (Sandboxed preload scripts cannot import other files, so only types are imported here.)

import { contextBridge, ipcRenderer } from 'electron';
import type { BotApi } from '../shared/api';

const api: BotApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  searchImages: (query) => ipcRenderer.invoke('image:search', query),
  useSearchImage: (image) => ipcRenderer.invoke('image:use-search', image),
  saveProcessedImage: (dataUrl) => ipcRenderer.invoke('image:save-processed', dataUrl),
  resetImage: () => ipcRenderer.invoke('image:reset'),
  setQuiet: (quiet) => ipcRenderer.invoke('quiet:set', quiet),
  chat: (message) => ipcRenderer.invoke('chat:send', message),
  setInteractive: (interactive) => ipcRenderer.send('window:interactive', interactive),
  quit: () => ipcRenderer.send('app:quit'),
};

contextBridge.exposeInMainWorld('bot', api);

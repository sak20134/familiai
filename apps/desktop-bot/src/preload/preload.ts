// The only bridge between the bot window and the main process. A small, fixed set of actions.
// (Sandboxed preload scripts are bundled into one file, so only types are imported here.)

import { contextBridge, ipcRenderer } from 'electron';
import type { BotApi, BotEvent } from '../shared/api';

const api: BotApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  ask: (text) => ipcRenderer.invoke('bot:ask', text),
  approve: (id) => ipcRenderer.invoke('bot:approve', id),
  reject: (id) => ipcRenderer.invoke('bot:reject', id),
  stop: () => ipcRenderer.send('bot:stop'),
  setAiMode: (on) => ipcRenderer.invoke('bot:ai-mode', on),
  updateConfig: (patch) => ipcRenderer.invoke('config:update', patch),
  setSecret: (name, value) => ipcRenderer.invoke('config:secret', name, value),
  connectStream: () => ipcRenderer.invoke('stream:connect'),
  connectGmail: () => ipcRenderer.invoke('gmail:connect'),
  addMember: (name, role) => ipcRenderer.invoke('family:add', name, role),
  removeMember: (id) => ipcRenderer.invoke('family:remove', id),
  startPairing: (memberId) => ipcRenderer.invoke('family:pair', memberId),
  cancelPairing: () => ipcRenderer.invoke('family:cancel-pair'),
  revokeDevice: (id) => ipcRenderer.invoke('family:revoke', id),
  setBotName: (name) => ipcRenderer.invoke('look:name', name),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  searchImages: (query) => ipcRenderer.invoke('image:search', query),
  useSearchImage: (image) => ipcRenderer.invoke('image:use-search', image),
  saveProcessedImage: (dataUrl) => ipcRenderer.invoke('image:save-processed', dataUrl),
  resetImage: () => ipcRenderer.invoke('image:reset'),
  setQuiet: (quiet) => ipcRenderer.invoke('quiet:set', quiet),
  setInteractive: (interactive) => ipcRenderer.send('window:interactive', interactive),
  setExpanded: (expanded) => ipcRenderer.send('window:expanded', expanded),
  onEvent: (listener) => {
    ipcRenderer.on('bot:event', (_e, ev: BotEvent) => listener(ev));
  },
  quit: () => ipcRenderer.send('app:quit'),
};

contextBridge.exposeInMainWorld('bot', api);

// The desktop tools the agent may use, each with its risk level.
//   low    - look at running apps, open an app or a website, read a web page
//   medium - close an app, type or press keys during take-over
//   high   - start take-over, force-close an app (unsaved work is lost)

import { fail, ok, str, num, type ToolDef } from '../agent/types';
import { closeApp, openApp, runningApps, type System } from './apps';
import type { TakeOver } from './takeover';
import { webSearch } from './search';
import { readPage } from './web';

export interface DesktopDeps {
  sys: System;
  takeover: TakeOver;
  openExternal: (url: string) => Promise<void>;
}

const ADULTS = ['owner', 'admin', 'adult', 'elder'] as const;

export function desktopTools(d: DesktopDeps): ToolDef[] {
  return [
    {
      spec: { name: 'list_apps', risk: 'low', description: 'List the apps running on this computer.' },
      input: { type: 'object', properties: {} },
      async run() {
        const names = await runningApps(d.sys);
        return ok(names.length ? `Running: ${names.join(', ')}.` : 'I could not see any apps running.');
      },
    },
    {
      spec: { name: 'open_app', risk: 'low', description: 'Open an app on this computer by name.' },
      input: { type: 'object', properties: { app: { type: 'string', description: 'App name, e.g. "notepad", "spotify", "obs"' } }, required: ['app'] },
      summarize: (a) => `Open ${str(a.app, 64)}`,
      run: (a) => openApp(str(a.app, 64), d.sys),
    },
    {
      spec: { name: 'close_app', risk: 'medium', description: 'Close an app, letting it save first.' },
      input: { type: 'object', properties: { app: { type: 'string', description: 'App name, e.g. "chrome", "minecraft"' } }, required: ['app'] },
      summarize: (a) => `Close ${str(a.app, 64)}`,
      run: (a) => closeApp(str(a.app, 64), d.sys, false),
    },
    {
      spec: { name: 'force_close_app', risk: 'high', description: 'Force an app to close right away. Unsaved work in it is lost.' },
      input: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
      summarize: (a) => `FORCE close ${str(a.app, 64)} (unsaved work is lost)`,
      run: (a) => closeApp(str(a.app, 64), d.sys, true),
    },
    {
      spec: { name: 'open_website', risk: 'low', description: 'Open a website in the normal web browser.' },
      input: { type: 'object', properties: { url: { type: 'string', description: 'Full address starting with https://' } }, required: ['url'] },
      summarize: (a) => `Open ${str(a.url, 200)}`,
      async run(a) {
        const url = str(a.url, 2000);
        if (!/^https?:\/\/[^\s]+$/i.test(url)) return fail('Give me a full web address starting with https://');
        await d.openExternal(url);
        return ok(`Opened ${url} in your browser.`);
      },
    },
    {
      spec: { name: 'web_search', risk: 'low', description: 'Search the web and get the top results (title, address, short text). Use read_webpage on a result to read it.' },
      input: { type: 'object', properties: { query: { type: 'string', description: 'What to search for' } }, required: ['query'] },
      async run(a) {
        const hits = await webSearch(str(a.query, 200));
        if (!hits.length) return ok('The search found nothing.');
        return ok(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join('\n'));
      },
    },
    {
      spec: { name: 'read_webpage', risk: 'low', description: 'Read a public web page and get its text, to answer questions precisely.' },
      input: { type: 'object', properties: { url: { type: 'string', description: 'Full address starting with https://' } }, required: ['url'] },
      async run(a) {
        const page = await readPage(str(a.url, 2000));
        return ok(`${page.title ? `Title: ${page.title}\n` : ''}Address: ${page.url}\n\n${page.text}`);
      },
    },
    {
      spec: { name: 'take_over', risk: 'high', description: 'Start take-over mode: the bot controls the keyboard for a few minutes to do a task.' },
      input: { type: 'object', properties: { minutes: { type: 'number', description: 'How long, 1 to 60. Default 10.' }, task: { type: 'string', description: 'What you will do' } } },
      roles: ADULTS,
      summarize: (a) => `Let the bot take over the keyboard for ${Math.min(60, Math.max(1, Math.round(num(a.minutes) || 10)))} minutes${str(a.task, 120) ? ` to ${str(a.task, 120)}` : ''}`,
      async run(a, actor) {
        const s = d.takeover.start(num(a.minutes) || 10, actor.name);
        const mins = Math.round((s.until - Date.now()) / 60_000);
        return ok(`Take-over is on for ${mins} minutes. Press Ctrl+Alt+S or say "stop" to end it at once.`);
      },
    },
    {
      spec: { name: 'type_text', risk: 'medium', description: 'Type text into the app in front (take-over must be on).' },
      input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      roles: ADULTS,
      summarize: (a) => `Type: "${str(a.text, 80)}${str(a.text).length > 80 ? '…' : ''}"`,
      async run(a) {
        const text = typeof a.text === 'string' ? a.text : '';
        await d.takeover.typeText(text);
        return ok(`Typed ${text.length} characters.`, false);
      },
    },
    {
      spec: { name: 'press_keys', risk: 'medium', description: 'Press a key or shortcut such as ctrl+s, alt+tab, enter (take-over must be on).' },
      input: { type: 'object', properties: { keys: { type: 'string', description: 'e.g. "ctrl+s", "enter", "alt+tab"' } }, required: ['keys'] },
      roles: ADULTS,
      summarize: (a) => `Press ${str(a.keys, 30)}`,
      async run(a) {
        const c = await d.takeover.pressKeys(str(a.keys, 30));
        return ok(`Pressed ${[...c.mods, c.key].join('+')}.`, false);
      },
    },
  ];
}

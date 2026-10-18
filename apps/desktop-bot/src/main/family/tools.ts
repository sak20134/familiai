// Family tools: screen-time limits (parents only) and the bot's scoped memory.
// Setting a limit is the parent's own decision, so it does not wait for anyone's OK; the role
// check means only the owner and admins can make or remove one.

import type { MemoryScope } from '@familiai/core';
import type { MemoryStore } from '../agent/memory';
import { fail, ok, num, str, type ToolDef } from '../agent/types';
import { closeApp, listProcesses, matchProcesses, type System } from '../desktop/apps';
import { GAME_APPS, type ScreenTime } from './screentime';

const PARENTS = ['owner', 'admin'] as const;

export function familyTools(d: { screen: ScreenTime; memory: MemoryStore; sys: System }): ToolDef[] {
  return [
    {
      // A parent's own instruction, like a limit, so it does not wait for a second OK.
      spec: { name: 'close_games', risk: 'low', description: 'Close every game and game launcher that is running right now.' },
      input: { type: 'object', properties: {} },
      roles: PARENTS,
      async run() {
        const procs = await listProcesses(d.sys);
        const running = [...new Set(GAME_APPS.filter((g) => matchProcesses(g, procs).length > 0))];
        if (running.length === 0) return ok('No games are running.');
        const results = await Promise.all(running.map((g) => closeApp(g, d.sys, true)));
        const failed = results.filter((r) => !r.ok);
        if (failed.length) return fail(`Closed ${running.length - failed.length} of ${running.length}. ${failed.map((f) => f.text).join(' ')}`);
        return ok(`Closed ${running.join(', ')}.`);
      },
    },
    {
      spec: { name: 'set_screen_limit', risk: 'low', description: 'Set a daily time limit for an app or for all games. At the limit the bot closes them.' },
      input: { type: 'object', properties: { app: { type: 'string', description: 'App name, or "gaming" for all games' }, minutes: { type: 'number', description: 'Minutes allowed per day' } }, required: ['app', 'minutes'] },
      roles: PARENTS,
      summarize: (a) => `Limit ${str(a.app, 40)} to ${num(a.minutes)} minutes a day`,
      async run(a, actor) {
        const rule = d.screen.setLimit(str(a.app, 40), num(a.minutes), actor.name);
        const games = rule.apps.length > 1 ? ' (all common games and game launchers)' : '';
        return ok(`${rule.label}${games} is now limited to ${formatMinutes(rule.dailyMinutes)} a day. I'll warn at 5 minutes and 1 minute left, then close it.`);
      },
    },
    {
      spec: { name: 'remove_screen_limit', risk: 'low', description: 'Remove a daily time limit.' },
      input: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] },
      roles: PARENTS,
      async run(a) {
        const removed = d.screen.removeLimit(str(a.app, 40));
        return removed ? ok(`Removed the ${removed.label} limit.`) : fail(`There is no limit called "${str(a.app, 40)}". Limits: ${d.screen.rules().map((r) => r.label).join(', ') || 'none'}.`);
      },
    },
    {
      spec: { name: 'screen_time', risk: 'low', description: 'How much time is used and left today for each limit.' },
      input: { type: 'object', properties: {} },
      async run() {
        const s = d.screen.status();
        if (s.length === 0) return ok('There are no screen-time limits.');
        return ok(s.map((x) => `${x.rule.label}: ${formatMinutes(x.usedMinutes)} used, ${formatMinutes(x.leftMinutes)} left of ${formatMinutes(x.rule.dailyMinutes)}`).join('\n'));
      },
    },
    {
      spec: { name: 'remember', risk: 'low', description: 'Save a note. Scope "private" (only this person), "family" (everyone) or "house" (home facts).' },
      input: { type: 'object', properties: { text: { type: 'string' }, scope: { type: 'string', enum: ['private', 'family', 'house'] } }, required: ['text'] },
      async run(a, actor) {
        const scope: MemoryScope = a.scope === 'family' || a.scope === 'house' ? a.scope : 'private';
        const item = d.memory.remember(actor, str(a.text, 500), scope);
        const who = scope === 'private' ? 'only you can see it' : scope === 'family' ? 'the family can see it' : 'saved as a house fact';
        return ok(`Saved (${who}): ${item.text}`);
      },
    },
    {
      spec: { name: 'recall', risk: 'low', description: 'Look up saved notes this person is allowed to see.' },
      input: { type: 'object', properties: { query: { type: 'string', description: 'What to look for' } } },
      async run(a, actor) {
        const items = d.memory.recall(actor, str(a.query, 200));
        return ok(items.length ? items.map((i) => `- ${i.text}`).join('\n') : 'I have no saved notes about that.');
      },
    },
  ];
}

export function formatMinutes(m: number): string {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} hour${h === 1 ? '' : 's'}`;
}

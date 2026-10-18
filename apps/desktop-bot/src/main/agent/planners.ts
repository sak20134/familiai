// Fixed commands that need no AI model: fast, exact, and free. Order matters: stream words
// ("start a poll", "close the poll") are tried before desktop words ("start", "close").

import { planCommand } from '@stream/tools';
import type { Plan, Planner } from './agent';

const clean = (s: string) => s.trim().replace(/^(hey|ok|okay)\s+\w+[,]?\s+/i, '').replace(/^(please|can you|could you)\s+/i, '').replace(/[.!?]+$/, '').trim();

const UNIT_MIN: Record<string, number> = { m: 1, min: 1, mins: 1, minute: 1, minutes: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60 };

export const streamPlanner: Planner = (text) => {
  const plan = planCommand(text);
  return plan ? { tool: `stream_${plan.tool}`, args: plan.args } : null;
};

export const familyPlanner: Planner = (text) => {
  const t = clean(text);
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(?:limit|set (?:a )?limit (?:on|for))\s+(.+?)\s+to\s+(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?)(?:\s+(?:a|per|each)\s+day)?$/i))) {
    return { tool: 'set_screen_limit', args: { app: m[1]!.replace(/^(the|my)\s+/i, ''), minutes: Number(m[2]) * (UNIT_MIN[m[3]!.toLowerCase()] ?? 1) } };
  }
  if ((m = t.match(/^(?:remove|delete|cancel|clear|stop)\s+(?:the\s+)?(.+?)\s+(?:time\s+)?limit$/i))) return { tool: 'remove_screen_limit', args: { app: m[1]! } };
  if (/^(?:close|quit|stop|end)\s+(?:all\s+)?(?:the\s+)?(?:games|gaming)(?:\s+(?:that are\s+)?(?:running|now))?$/i.test(t)) return { tool: 'close_games', args: {} };
  if (/^(?:screen ?time|time left|how much (?:game|gaming|screen|play) ?time(?: is)? left)$/i.test(t)) return { tool: 'screen_time', args: {} };
  if ((m = t.match(/^remember(?:\s+for\s+(?:the\s+)?(family|house|home))?[:,]?\s+(?:that\s+)?(.+)$/i))) {
    const scope = m[1] ? (m[1].toLowerCase() === 'family' ? 'family' : 'house') : 'private';
    return { tool: 'remember', args: { scope, text: m[2]! } };
  }
  if ((m = t.match(/^(?:what do you remember(?: about)?|recall|what did i (?:tell you|save) about)\s*(.*)$/i))) return { tool: 'recall', args: { query: m[1] ?? '' } };
  return null;
};

// One to three words: "spotify", "google chrome", "epic games launcher". Longer requests go to the AI.
const APP = String.raw`([\p{L}\p{N}._+-]+(?:\s+[\p{L}\p{N}._+-]+){0,2})`;
const OPEN = new RegExp(String.raw`^(?:open|launch|start|run)\s+(?:the\s+|my\s+)?(?:app\s+)?${APP}$`, 'iu');
const CLOSE = new RegExp(String.raw`^(force\s+)?(?:close|quit|kill|exit|shut down)\s+(?:the\s+|my\s+)?(?:app\s+)?${APP}$`, 'iu');
const KEYS = /^press\s+((?:(?:ctrl|control|alt|option|shift|cmd|command|win|super|meta)\s*\+\s*)*(?:[a-z0-9]|f\d{1,2}|enter|tab|esc|escape|backspace|delete|up|down|left|right|home|end|pageup|pagedown|space))$/i;

const SITE = /^(https?:\/\/\S+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|in|dev|app|tv|gg|edu|gov|co|me|ai)(?:\/\S*)?)$/i;

export const desktopPlanner: Planner = (text) => {
  const t = clean(text);
  let m: RegExpMatchArray | null;
  if (/^(?:what(?:'s| is| apps are)|which apps are)\s+(?:running|open)(?: right now)?$|^(?:list|show)(?: me)?(?: the)?(?: running| open)? apps$/i.test(t)) return { tool: 'list_apps', args: {} };
  if ((m = t.match(/^take ?over(?:\s+(?:for\s+)?(\d{1,2})\s*(?:m|mins?|minutes?))?$/i))) return { tool: 'take_over', args: { minutes: m[1] ? Number(m[1]) : 10 } };
  if ((m = t.match(/^(?:open|launch|start|run|go to)\s+(?:the\s+)?(?:website\s+)?(\S+)$/i)) && SITE.test(m[1]!)) {
    const url = /^https?:\/\//i.test(m[1]!) ? m[1]! : `https://${m[1]!}`;
    return { tool: 'open_website', args: { url } };
  }
  const app = (s: string) => s.replace(/\s+app$/i, '');
  if ((m = t.match(OPEN))) return { tool: 'open_app', args: { app: app(m[1]!) } };
  if ((m = t.match(CLOSE))) return { tool: m[1] ? 'force_close_app' : 'close_app', args: { app: app(m[2]!) } };
  // Typing needs quotes or a colon, so a question like "type of birds in India" is not typed out.
  if ((m = t.match(/^type(?::\s*|\s+["“])(.+?)["”]?$/i))) return { tool: 'type_text', args: { text: m[1]! } };
  if ((m = t.match(KEYS))) return { tool: 'press_keys', args: { keys: m[1]! } };
  return null;
};

export const PLANNERS: readonly Planner[] = [streamPlanner, familyPlanner, desktopPlanner];

export type { Plan };

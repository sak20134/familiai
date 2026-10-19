// Helps a small brain by offering it only the few tools that fit the request, with one worked
// example for each. A small model picks far better from 5 tools than from 29. This only changes
// what the brain is OFFERED; every call it makes still goes through the gate.

import type { InputSchema } from './types';

interface Hint {
  /** Words or phrases that suggest this tool. */
  words: RegExp;
  /** One example: what a person says, and the call that answers it. */
  example: string;
}

const HINTS: Record<string, Hint> = {
  list_apps: { words: /\b(running|open apps?|what apps|which (apps|programs)|programs?)\b/i, example: 'what apps are running? -> list_apps {}' },
  open_app: { words: /\b(open|start|launch|run|fire up|get .* going|need)\b/i, example: 'open spotify -> open_app {"app":"spotify"}' },
  close_app: { words: /\b(close|quit|shut|exit|done with)\b/i, example: 'close discord -> close_app {"app":"discord"}' },
  force_close_app: { words: /\b(force|kill|frozen|froze|hung|not responding|isn'?t responding|terminate)\b/i, example: 'chrome froze, kill it -> force_close_app {"app":"chrome"}' },
  open_website: { words: /\b(website|site|go to|visit|browser|youtube|google|wikipedia|twitch|github|netflix|gmail|reddit|https?:|\.com|take me to|pull up)\b/i, example: 'go to youtube -> open_website {"url":"https://www.youtube.com"}' },
  web_search: { words: /\b(search|google|look up|find out|who is|what is|latest|news|how (do|to))\b/i, example: 'search for pasta recipes -> web_search {"query":"pasta recipes"}' },
  check_email: { words: /\b(emails?|mail|inbox|gmail|unread|messages? from)\b/i, example: 'check my email -> check_email {}' },
  read_email: { words: /\b(read|open)\b.*\b(emails?|mail|message)\b/i, example: 'read that email -> read_email {"id":"<id from check_email>"}' },
  read_webpage: { words: /\b(read|summari[sz]e|what'?s on|what does .* say|look at|https?:|\.com|page)\b/i, example: 'read https://example.com and summarise -> read_webpage {"url":"https://example.com"}' },
  take_over: { words: /\b(take ?over|drive the computer|control the (keyboard|computer))\b/i, example: 'take over for 10 minutes -> take_over {"minutes":10}' },
  type_text: { words: /\b(type|write out|write:)\b/i, example: 'type: hello -> type_text {"text":"hello"}' },
  press_keys: { words: /\b(press|hit|ctrl|alt\+|shortcut|enter|escape|key)\b/i, example: 'press ctrl+s -> press_keys {"keys":"ctrl+s"}' },
  close_games: { words: /\b(games?|gaming)\b.*\b(close|stop|shut|quit|end)\b|\b(close|stop|shut|quit|end)\b.*\b(games?|gaming)\b/i, example: 'close all games -> close_games {}' },
  set_screen_limit: { words: /\b(limit|allowed|only .* minutes|minutes? (a|per) day|daily)\b/i, example: 'limit gaming to 60 minutes -> set_screen_limit {"app":"gaming","minutes":60}' },
  remove_screen_limit: { words: /\b(remove|cancel|clear|delete|stop)\b.*\blimit\b/i, example: 'remove the gaming limit -> remove_screen_limit {"app":"gaming"}' },
  screen_time: { words: /\b(screen ?time|time (left|used)|how much .*time|play ?time)\b/i, example: 'how much time is left? -> screen_time {}' },
  remember: { words: /\b(remember|note that|don'?t forget|save)\b/i, example: 'remember the spare key is under the pot -> remember {"text":"the spare key is under the pot","scope":"private"}' },
  recall: { words: /\b(recall|what do you (remember|know)|what did i (tell|save)|did i tell)\b/i, example: 'what do you remember about the key? -> recall {"query":"key"}' },
  stream_obs_switch_scene: { words: /\b(scene|switch to|cut to|brb|gameplay|starting soon|just chatting)\b/i, example: 'switch to BRB -> stream_obs_switch_scene {"scene":"BRB"}' },
  stream_obs_mute: { words: /\b(mute|unmute|mic|microphone|silence)\b/i, example: 'mute my mic -> stream_obs_mute {"input":"Mic","muted":true}' },
  stream_obs_start_stream: { words: /\b(go live|start (the )?(stream|streaming)|begin broadcast|we'?re live)\b/i, example: 'go live -> stream_obs_start_stream {}' },
  stream_obs_stop_stream: { words: /\b(end|stop|finish)\b.*\b(stream|streaming|broadcast)\b|\bgo offline\b/i, example: 'end the stream -> stream_obs_stop_stream {}' },
  stream_chat_say: { words: /\b(say in chat|tell chat|post in chat|announce|in chat)\b/i, example: 'tell chat we start soon -> stream_chat_say {"text":"We start soon!"}' },
  stream_chat_timeout: { words: /\b(time ?out|mute chatter|spamming)\b/i, example: 'timeout bob for 5 minutes -> stream_chat_timeout {"user":"bob","seconds":300}' },
  stream_chat_ban: { words: /\b(ban|kick)\b/i, example: 'ban bob -> stream_chat_ban {"user":"bob"}' },
  stream_chat_pardon: { words: /\b(pardon|forgive|strikes|warnings)\b/i, example: 'pardon bob -> stream_chat_pardon {"user":"bob"}' },
  stream_command_set: { words: /!\w+|\b(command)\b/i, example: 'add a !discord command that says join us -> stream_command_set {"name":"discord","reply":"join us"}' },
  stream_poll_start: { words: /\b(poll)\b/i, example: 'poll: pizza or burgers? -> stream_poll_start {"question":"Pizza or burgers?","options":["Pizza","Burgers"]}' },
  stream_poll_end: { words: /\b(end|close|finish|result|wrap up)\b.*\bpoll\b|\bpoll\b.*\b(result|end)\b/i, example: 'end the poll -> stream_poll_end {}' },
  stream_giveaway_start: { words: /\b(giveaway)\b/i, example: 'start a giveaway for a gift card -> stream_giveaway_start {"prize":"gift card"}' },
  stream_giveaway_draw: { words: /\b(draw|pick|choose)\b.*\b(winner|giveaway)\b|\bwho won\b/i, example: 'draw the winner -> stream_giveaway_draw {}' },
  stream_summary: { words: /\b(summar|recap|how is the stream|stream summary)\b/i, example: 'summarise the stream -> stream_summary {}' },
};

/** Tools offered when nothing in the request stands out. */
const DEFAULT_SET = ['open_app', 'close_app', 'open_website', 'web_search', 'list_apps', 'remember', 'recall', 'screen_time'];
export const MAX_OFFERED = 6;

export interface Pickable {
  name: string;
  description: string;
  input: InputSchema;
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z]{3,}/g) ?? []);
}

/** The tools worth offering for this request (best first), at most `max`. */
export function pickTools<T extends Pickable>(request: string, tools: readonly T[], max = MAX_OFFERED): T[] {
  const asked = words(request);
  const scored = tools.map((t) => {
    let score = 0;
    const h = HINTS[t.name];
    if (h?.words.test(request)) score += 3;
    // The tool's own name or description words appearing in the request count a little.
    for (const w of words(t.name.replace(/_/g, ' '))) if (asked.has(w)) score += 1;
    for (const w of words(t.description)) if (asked.has(w) && w.length > 4) score += 0.25;
    return { t, score };
  });
  const best = scored.filter((s) => s.score >= 1).sort((a, b) => b.score - a.score).slice(0, max).map((s) => s.t);
  if (best.length > 0) return best;
  const fallback = tools.filter((t) => DEFAULT_SET.includes(t.name));
  return fallback.length ? fallback : tools.slice(0, max);
}

/** Short worked examples for the offered tools, to show the brain the pattern. */
export function examplesFor(tools: ReadonlyArray<{ name: string }>, max = 3): string[] {
  return tools.map((t) => HINTS[t.name]?.example).filter((e): e is string => Boolean(e)).slice(0, max);
}

/** Only the fields the tool really has. Small brains sometimes invent extra ones. */
export function keepKnown(input: InputSchema, args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([k]) => k in input.properties));
}

/** What is wrong with a tool call's arguments, in words for the brain, or null when they are fine. */
export function checkArgs(input: InputSchema, args: Record<string, unknown>): string | null {
  const problems: string[] = [];
  for (const key of input.required ?? []) {
    const v = args[key];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) problems.push(`"${key}" is missing`);
  }
  for (const [key, v] of Object.entries(args)) {
    const spec = input.properties[key];
    if (!spec) continue; // extra fields are dropped by keepKnown(), not argued about
    const type = Array.isArray(v) ? 'array' : typeof v;
    if (spec.type === 'number' && type !== 'number') problems.push(`"${key}" must be a number`);
    else if (spec.type === 'string' && type !== 'string') problems.push(`"${key}" must be text`);
    else if (spec.type === 'boolean' && type !== 'boolean') problems.push(`"${key}" must be true or false`);
    else if (spec.type === 'array' && type !== 'array') problems.push(`"${key}" must be a list`);
    else if (spec.enum && typeof v === 'string' && !spec.enum.includes(v)) problems.push(`"${key}" must be one of: ${spec.enum.join(', ')}`);
  }
  return problems.length ? problems.join('; ') : null;
}

// What the copilot can do, how risky each thing is, and a planner that turns what the streamer
// says ("go to BRB", "timeout spammer 5 minutes") into a tool call without needing an AI model.
//
// Risk follows Family AI's rules (from @familiai/core):
//   low    - runs straight away (switch scene, mute, post in chat)
//   medium - runs straight away in Autopilot, otherwise asks (timeouts, starting the stream)
//   high   - ALWAYS asks, every time (bans, ending the stream)

import type { ToolSpec } from '@familiai/core';

export const TOOLS = {
  obs_switch_scene: { name: 'obs_switch_scene', risk: 'low', description: 'Switch the live OBS scene.' },
  obs_mute: { name: 'obs_mute', risk: 'low', description: 'Mute or unmute an OBS audio source.' },
  obs_start_stream: { name: 'obs_start_stream', risk: 'medium', description: 'Go live.' },
  obs_stop_stream: { name: 'obs_stop_stream', risk: 'high', description: 'End the stream.' },
  chat_say: { name: 'chat_say', risk: 'low', description: 'Post a message in chat.' },
  chat_timeout: { name: 'chat_timeout', risk: 'medium', description: 'Time a chatter out.' },
  chat_ban: { name: 'chat_ban', risk: 'high', description: 'Ban a chatter permanently.' },
  chat_pardon: { name: 'chat_pardon', risk: 'low', description: "Clear a chatter's strikes." },
  command_set: { name: 'command_set', risk: 'low', description: 'Add or change a !command.' },
  poll_start: { name: 'poll_start', risk: 'low', description: 'Start a chat poll.' },
  poll_end: { name: 'poll_end', risk: 'low', description: 'Close the poll and post the result.' },
  giveaway_start: { name: 'giveaway_start', risk: 'low', description: 'Open a giveaway.' },
  giveaway_draw: { name: 'giveaway_draw', risk: 'medium', description: 'Draw the giveaway winner.' },
  summary: { name: 'summary', risk: 'low', description: 'Summarise the stream so far.' },
} as const satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof TOOLS;

export interface Plan {
  tool: ToolName;
  args: Record<string, unknown>;
}

const UNITS: Record<string, number> = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600 };

/** Scene nicknames people actually say. */
const SCENE_WORDS: Record<string, string> = { brb: 'brb', 'be right back': 'be right back', 'starting soon': 'starting soon', ending: 'ending', 'just chatting': 'just chatting', gameplay: 'gameplay', game: 'gameplay' };

const user = (s: string) => s.trim().replace(/^@/, '').replace(/[.,!?]+$/, '');

export function planCommand(input: string): Plan | null {
  const t = input.trim().replace(/^(hey|ok|okay)\s+\w+[,]?\s+/i, '').replace(/^(please|can you|could you)\s+/i, '').replace(/[.!?]+$/, '');
  let m: RegExpMatchArray | null;

  if ((m = t.match(/^(?:switch|go|change|cut)\s+(?:the\s+scene\s+)?to\s+(?:the\s+)?(.+?)(?:\s+scene)?$/i))) return { tool: 'obs_switch_scene', args: { scene: m[1]!.trim() } };
  const bare = SCENE_WORDS[t.toLowerCase()];
  if (bare) return { tool: 'obs_switch_scene', args: { scene: bare } };

  if ((m = t.match(/^(un)?mute\s+(?:my\s+|the\s+)?(.+)$/i))) return { tool: 'obs_mute', args: { input: m[2]!.trim(), muted: !m[1] } };

  if (/^(?:go live|start (?:the )?stream(?:ing)?)$/i.test(t)) return { tool: 'obs_start_stream', args: {} };
  if (/^(?:end|stop) (?:the )?stream(?:ing)?$/i.test(t)) return { tool: 'obs_stop_stream', args: {} };

  if ((m = t.match(/^time\s*out\s+(\S+)(?:\s+(?:for\s+)?(\d{1,5})\s*([a-z]+)?)?(?:\s+(?:for|because)\s+(.+))?$/i))) {
    const n = m[2] ? Number(m[2]) : 10;
    const unit = UNITS[(m[3] ?? 'minutes').toLowerCase()] ?? 60;
    return { tool: 'chat_timeout', args: { user: user(m[1]!), seconds: n * unit, reason: m[4]?.trim() ?? 'timed out by the streamer' } };
  }
  if ((m = t.match(/^ban\s+(\S+)(?:\s+(?:for|because)\s+(.+))?$/i))) return { tool: 'chat_ban', args: { user: user(m[1]!), reason: m[2]?.trim() ?? 'banned by the streamer' } };
  if ((m = t.match(/^(?:pardon|forgive)\s+(\S+)$/i))) return { tool: 'chat_pardon', args: { user: user(m[1]!) } };

  if ((m = t.match(/^(?:say|tell chat|post)\s+(.+)$/i))) return { tool: 'chat_say', args: { text: m[1]!.trim() } };

  if ((m = t.match(/^(?:add|set|make)\s+(?:a\s+)?command\s+!?(\w+)\s+(?:that says\s+|to say\s+|saying\s+)?(.+)$/i))) {
    return { tool: 'command_set', args: { name: m[1]!, reply: m[2]!.trim() } };
  }

  if ((m = t.match(/^(?:start|make|run)\s+a\s+poll[:,]?\s+(.+)$/i))) {
    // "best snack? chips or popcorn" or "best snack: chips, popcorn". The question ends at ? or : or " - ".
    const body = m[1]!;
    const cut = body.search(/\?|:|\s-\s/);
    if (cut > 0) {
      const question = body.slice(0, cut).trim();
      const options = body.slice(cut + 1).split(/\s*(?:,|\bor\b)\s*/i).map((o) => o.trim()).filter(Boolean);
      if (options.length >= 2) return { tool: 'poll_start', args: { question, options } };
    }
    return null;
  }
  if (/^(?:end|close|stop) (?:the )?poll$/i.test(t)) return { tool: 'poll_end', args: {} };

  if ((m = t.match(/^(?:start|run|open)\s+a\s+giveaway(?:\s+for\s+(.+))?$/i))) return { tool: 'giveaway_start', args: { prize: m[1]?.trim() ?? 'a prize' } };
  if (/^(?:draw|pick)(?: the| a)? winner$/i.test(t)) return { tool: 'giveaway_draw', args: {} };

  if (/^(?:summary|summari[sz]e|how(?:'s| is) (?:the )?stream (?:going|doing))/i.test(t)) return { tool: 'summary', args: {} };

  return null;
}

// The five modes. Each one decides which tools the AI may use and how it should speak.
// Server-side rules, never left to the model: a mode can only ever REMOVE tools, never add any.

import type { Role } from './roles';

export type Mode = 'chat' | 'voice' | 'coder' | 'learn' | 'twin';

export const MODES: readonly Mode[] = ['chat', 'voice', 'coder', 'learn', 'twin'];

export const isMode = (v: unknown): v is Mode => typeof v === 'string' && (MODES as readonly string[]).includes(v);

export interface ModeInfo {
  label: string;
  /** Tools the AI may use here. '*' means every tool; a list means only those. */
  tools: '*' | readonly string[];
  /** Replies are read out loud, so they must stay short and plain. */
  spoken: boolean;
  /** Extra instructions added to the system prompt. */
  lines: readonly string[];
}

const INFO: Record<Mode, ModeInfo> = {
  chat: { label: 'Chat', tools: '*', spoken: false, lines: [] },
  voice: {
    label: 'Voice',
    tools: '*',
    spoken: true,
    lines: [
      'Your reply is read out loud. Use at most two short sentences of plain spoken words.',
      'Never read out bullet lists, code, links or symbols: say them in words instead.',
    ],
  },
  coder: {
    label: 'Coder',
    tools: [],
    spoken: false,
    lines: [
      'You are in coding mode and help with code only.',
      'You have NO tools here, so never say you ran, saved, installed or deployed anything.',
      'Give complete code in fenced blocks that start with the language name, and keep the words around it short.',
    ],
  },
  learn: {
    label: 'Learn',
    tools: ['recall', 'remember', 'add_reminder', 'list_reminders'],
    spoken: false,
    lines: [
      'You are a patient learning coach. Teach one small step at a time and ask one question at a time.',
      'Never just hand over the answer to homework: give a hint, let them try, then confirm and praise real effort.',
      // Vygotsky's zone of proximal development: find the edge of what they can do alone, help only there.
      'Start with what they can already do on their own, then work just past that edge. Give only as much help as the step needs, and take the help away again as soon as they manage without it.',
      // The Feynman cycle: explain, find the gap, rebuild, say it again simply, then use it.
      'Ask them to explain it back in their own words. Where the explanation breaks is the real gap: name it kindly, let them rebuild it themselves, then have them say it again simply and use it on a fresh example.',
      'Finish a topic by telling them what they got right and the one thing to practise next.',
      'Stay on learning. In this mode you cannot spend money, call anyone or change family settings.',
    ],
  },
  twin: {
    label: 'Family Twin',
    tools: ['recall'],
    spoken: false,
    lines: [],
  },
};

export const modeInfo = (mode: Mode): ModeInfo => INFO[mode];

/** Guests only get plain chat and voice. Everyone else in the family gets all five. */
export function modeAllowed(mode: Mode, role: Role): boolean {
  if (role === 'guest') return mode === 'chat' || mode === 'voice';
  return true;
}

/** Keeps only the tools this mode allows. Nothing can widen the list. */
export function toolsForMode<T extends { spec: { name: string } }>(mode: Mode, tools: readonly T[]): readonly T[] {
  const allowed = INFO[mode].tools;
  if (allowed === '*') return tools;
  return tools.filter((t) => allowed.includes(t.spec.name));
}

/**
 * Family Twin: answers as a GUESS of what someone would say, never as that person.
 * `facts` must already be filtered to what the person asking is allowed to read.
 */
export function twinPrompt(name: string, facts: readonly string[]): readonly string[] {
  return [
    `You are answering as a guess of what ${name} would probably say, based only on what ${name} chose to share with the family.`,
    `You are NOT ${name}. Start your reply with "Guessing from what ${name} shared:" and never pretend to be them.`,
    `Never invent facts about ${name}. If the shared notes do not cover the question, say so plainly.`,
    facts.length > 0
      ? `What ${name} has shared:\n${facts.map((f) => `- ${f}`).join('\n')}`
      : `${name} has not shared anything yet, so say there is not enough to go on.`,
  ];
}

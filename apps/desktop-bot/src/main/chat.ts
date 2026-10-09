// Chat bubble brain. With a model key it asks the model; without one it gives a clear demo reply.

import type { ChatReply } from '../shared/api';

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export const MAX_MESSAGE_CHARS = 1000;
export const MAX_HISTORY_TURNS = 10;

export function systemPrompt(botName: string): string {
  return [
    `You are ${botName}, a friendly desktop companion that lives on the user's screen.`,
    'Keep replies short (one to three sentences) and warm.',
    'You cannot control the computer yet. If asked to do something on the computer, say that this will come later.',
    'Never claim to have done something you did not do.',
  ].join(' ');
}

export function demoReply(message: string, botName: string): string {
  const m = message.toLowerCase();
  if (/\b(hi|hello|hey)\b/.test(m)) return `Hi! I'm ${botName}. (Demo mode: add a model key to chat for real.)`;
  if (m.includes('who are you')) return `I'm ${botName}, your desktop buddy. Right now I'm in demo mode.`;
  return `I heard you! I'm in demo mode, so I can't think yet. Add your model key in the .env file and I'll answer for real.`;
}

export function buildRequestBody(history: readonly Turn[], model: string, botName: string) {
  return {
    model,
    max_tokens: 300,
    system: systemPrompt(botName),
    messages: history.slice(-MAX_HISTORY_TURNS).map((t) => ({ role: t.role, content: t.content })),
  };
}

export function parseModelReply(json: unknown): string {
  const content = (json as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) throw new Error('The model sent back something unexpected.');
  const text = content
    .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('')
    .trim();
  if (!text) throw new Error('The model sent an empty answer.');
  return text;
}

export interface ChatOptions {
  message: string;
  history: readonly Turn[]; // earlier turns, NOT including this message
  botName: string;
  apiKey: string | undefined;
  model: string;
  fetchImpl?: typeof fetch;
}

export async function reply(opts: ChatOptions): Promise<ChatReply> {
  const message = opts.message.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) throw new Error('Type something first.');
  if (!opts.apiKey) return { text: demoReply(message, opts.botName), demo: true };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const body = buildRequestBody([...opts.history, { role: 'user', content: message }], opts.model, opts.botName);
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    // Show the real reason (wrong key, no credit, ...) but never the key itself.
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`The model request failed (${res.status}). ${detail}`);
  }
  return { text: parseModelReply(await res.json()), demo: false };
}

// "My own API": a brain that lives on a chat service instead of this computer. It speaks the
// common OpenAI-style chat format, which DeepSeek, OpenAI, Gemini, Groq, OpenRouter and local
// programs such as Ollama or LM Studio all understand. It is only used when the person picks it in
// Settings, and then what they say is sent to that service. Like every brain, it only PROPOSES
// tool calls; the gate still decides what really runs.

import type { ChatHistoryItem, ChatModelFunctions } from 'node-llama-cpp';
import type { Engine, GenerateResult } from './brain';

export interface ApiOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The clean base address, or null when it is not allowed: https, or http only on this computer. */
export function parseApiUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password) return null;
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

export function isLocalApi(raw: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(raw.trim()).hostname);
  } catch {
    return false;
  }
}

interface ApiCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ApiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ApiCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** The bot's conversation, rewritten in the chat format the service expects. */
export function toApiMessages(history: readonly ChatHistoryItem[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  let n = 0;
  for (const item of history) {
    if (item.type === 'system') out.push({ role: 'system', content: typeof item.text === 'string' ? item.text : JSON.stringify(item.text) });
    else if (item.type === 'user') out.push({ role: 'user', content: item.text });
    else if (item.type === 'model') {
      let text = '';
      let calls: ApiCall[] = [];
      let results: ApiMessage[] = [];
      const flush = () => {
        if (calls.length) out.push({ role: 'assistant', content: text || null, tool_calls: calls }, ...results);
        else if (text) out.push({ role: 'assistant', content: text });
        text = '';
        calls = [];
        results = [];
      };
      for (const part of item.response) {
        if (typeof part === 'string') {
          if (calls.length) flush(); // words after a tool's result start a new message
          text += (text ? '\n' : '') + part;
        } else if (part.type === 'functionCall') {
          const id = `call_${++n}`;
          calls.push({ id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.params ?? {}) } });
          const r = part.result;
          results.push({ role: 'tool', tool_call_id: id, content: r === undefined ? 'No result.' : typeof r === 'string' ? r : JSON.stringify(r) });
        }
      }
      flush();
    }
  }
  return out;
}

interface ApiTool { type: 'function'; function: { name: string; description: string; parameters: unknown } }

/** The bot's tools in the service's format. The "may be null" wrapper the local brain needs is dropped. */
export function toApiTools(functions: ChatModelFunctions | undefined): ApiTool[] {
  return Object.entries(functions ?? {}).map(([name, f]) => {
    const params = (f as { description?: string; params?: { properties?: Record<string, unknown> } }).params;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, p] of Object.entries(params?.properties ?? {})) {
      const nullable = p as { oneOf?: unknown[] };
      if (Array.isArray(nullable.oneOf)) properties[key] = nullable.oneOf[0];
      else { properties[key] = p; required.push(key); }
    }
    return { type: 'function', function: { name, description: (f as { description?: string }).description ?? '', parameters: { type: 'object', properties, ...(required.length ? { required } : {}) } } };
  });
}

function explain(status: number, body: string): string {
  if (status === 401 || status === 403) return 'The API did not accept the key. Check it in Settings.';
  if (status === 404) return 'The API address or the model name was not found. Check both in Settings.';
  if (status === 429) return 'The API says there were too many requests (a free plan has limits). Try again in a minute.';
  if (status >= 500) return 'The API had a problem on its side. Try again soon.';
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 160);
  return `The API returned an error (${status})${detail ? `: ${detail}` : ''}.`;
}

export function createApiEngine(o: ApiOptions): Engine {
  const base = parseApiUrl(o.baseUrl);
  if (!base) throw new Error('The API address must start with https:// (or http:// for a program on this computer).');
  if (!o.model.trim()) throw new Error('Type the model name for your API in Settings.');
  if (!o.apiKey && !isLocalApi(o.baseUrl)) throw new Error('Paste your API key in Settings.');

  return {
    async generate(history, functions): Promise<GenerateResult> {
      const tools = toApiTools(functions);
      const known = new Set(tools.map((t) => t.function.name));
      let res: Response;
      try {
        res = await (o.fetchImpl ?? fetch)(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(o.apiKey ? { authorization: `Bearer ${o.apiKey}` } : {}) },
          body: JSON.stringify({ model: o.model.trim(), messages: toApiMessages(history), ...(tools.length ? { tools } : {}), temperature: 0.2, max_tokens: 700 }),
          signal: AbortSignal.timeout(o.timeoutMs ?? 90_000),
        });
      } catch {
        throw new Error('I could not reach the API. Check your internet connection and the address in Settings.');
      }
      if (!res.ok) throw new Error(explain(res.status, await res.text().catch(() => '')));
      const data = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }> } }> } | null;
      const message = data?.choices?.[0]?.message;
      if (!message) throw new Error('The API sent back something I could not read.');
      const text = typeof message.content === 'string' ? message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '';
      const calls: GenerateResult['calls'] = [];
      for (const c of message.tool_calls ?? []) {
        const name = c.function?.name;
        if (typeof name !== 'string' || !known.has(name)) continue; // a tool the bot does not have is ignored
        let params: unknown = {};
        try {
          params = typeof c.function?.arguments === 'string' && c.function.arguments.trim() ? JSON.parse(c.function.arguments) : {};
        } catch {
          params = {};
        }
        calls.push({ name, params, raw: undefined });
      }
      return { text, calls };
    },
    async close() {},
  };
}

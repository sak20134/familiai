// Talks to an AI model with tools. Two providers behind one small interface:
//   anthropic - Claude through the Messages API (needs a key)
//   ollama    - a free model running on this computer (needs Ollama installed)
// The model only ever PROPOSES tool calls; the agent decides, through the gate, what really runs.

import type { InputSchema } from './types';

export type ProviderName = 'anthropic' | 'ollama';

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  /** Anthropic key. Sent only in a request header, never logged or put in the body. */
  apiKey?: string;
  /** Ollama address, default http://127.0.0.1:11434 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ModelTool {
  name: string;
  description: string;
  input: InputSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface Step {
  text: string;
  calls: ToolCall[];
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** One conversation with tools. step() asks the model; addResults() hands back what the tools did. */
export interface Session {
  step(): Promise<Step>;
  addResults(results: Array<{ call: ToolCall; content: string }>): void;
}

export const DEFAULT_MODELS: Record<ProviderName, string> = { anthropic: 'claude-sonnet-5-5', ollama: 'llama3.2' };
const MAX_TOKENS = 800;

export function openSession(cfg: ModelConfig, system: string, history: readonly Turn[], tools: readonly ModelTool[]): Session {
  if (cfg.provider === 'anthropic') {
    if (!cfg.apiKey) throw new Error('No Claude key is set. Add it in Settings, or switch to Ollama to run a free model on this computer.');
    return new AnthropicSession(cfg, system, history, tools);
  }
  return new OllamaSession(cfg, system, history, tools);
}

async function post(cfg: ModelConfig, url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 60_000),
    });
  } catch (err) {
    if (cfg.provider === 'ollama') throw new Error(`Could not reach Ollama at ${cfg.baseUrl ?? 'http://127.0.0.1:11434'}. Is it installed and running?`);
    throw new Error(`Could not reach the AI service: ${(err as Error).message}`);
  }
  if (!res.ok) {
    // The real reason (wrong key, no credit, model not pulled), but never the key itself.
    const detail = (await res.text()).slice(0, 200).replace(cfg.apiKey ?? '\u0000', '[hidden]');
    throw new Error(`The AI request failed (${res.status}). ${detail}`);
  }
  return res.json();
}

// --- Claude ---------------------------------------------------------------------------------

type ABlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

class AnthropicSession implements Session {
  private readonly messages: Array<{ role: 'user' | 'assistant'; content: string | ABlock[] }>;

  constructor(private readonly cfg: ModelConfig, private readonly system: string, history: readonly Turn[], private readonly tools: readonly ModelTool[]) {
    this.messages = history.map((t) => ({ role: t.role, content: t.content }));
  }

  async step(): Promise<Step> {
    const json = await post(this.cfg, 'https://api.anthropic.com/v1/messages', { 'x-api-key': this.cfg.apiKey ?? '', 'anthropic-version': '2023-06-01' }, {
      model: this.cfg.model,
      max_tokens: MAX_TOKENS,
      system: this.system,
      messages: this.messages,
      ...(this.tools.length ? { tools: this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input })) } : {}),
    });
    const content = (json as { content?: unknown }).content;
    if (!Array.isArray(content)) throw new Error('The AI sent back something unexpected.');
    const blocks = content as ABlock[];
    this.messages.push({ role: 'assistant', content: blocks });
    return parseAnthropic(blocks);
  }

  addResults(results: Array<{ call: ToolCall; content: string }>): void {
    this.messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.call.id, content: r.content })) });
  }
}

export function parseAnthropic(blocks: readonly unknown[]): Step {
  let text = '';
  const calls: ToolCall[] = [];
  for (const b of blocks) {
    const block = b as Partial<ABlock> | null;
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    if (block?.type === 'tool_use' && typeof block.name === 'string' && typeof block.id === 'string') {
      calls.push({ id: block.id, name: block.name, args: block.input && typeof block.input === 'object' ? block.input : {} });
    }
  }
  return { text: text.trim(), calls };
}

// --- Ollama ---------------------------------------------------------------------------------

interface OMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> | string } }>;
  tool_name?: string;
}

class OllamaSession implements Session {
  private readonly messages: OMessage[];
  private counter = 0;

  constructor(private readonly cfg: ModelConfig, system: string, history: readonly Turn[], private readonly tools: readonly ModelTool[]) {
    this.messages = [{ role: 'system', content: system }, ...history.map((t) => ({ role: t.role, content: t.content }))];
  }

  async step(): Promise<Step> {
    const base = (this.cfg.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const json = await post(this.cfg, `${base}/api/chat`, {}, {
      model: this.cfg.model,
      stream: false,
      messages: this.messages,
      ...(this.tools.length ? { tools: this.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input } })) } : {}),
    });
    const msg = (json as { message?: OMessage }).message;
    if (!msg || typeof msg.content !== 'string') throw new Error('Ollama sent back something unexpected.');
    this.messages.push(msg);
    const step = parseOllama(msg, () => `call${++this.counter}`);
    return step;
  }

  addResults(results: Array<{ call: ToolCall; content: string }>): void {
    for (const r of results) this.messages.push({ role: 'tool', content: r.content, tool_name: r.call.name });
  }
}

export function parseOllama(msg: OMessage, newId: () => string): Step {
  const calls: ToolCall[] = [];
  for (const c of msg.tool_calls ?? []) {
    const name = c?.function?.name;
    if (typeof name !== 'string') continue;
    let args = c.function.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    calls.push({ id: newId(), name, args: args && typeof args === 'object' ? args : {} });
  }
  // Some local models wrap their thinking in <think> tags; the user only gets the answer.
  return { text: msg.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), calls };
}

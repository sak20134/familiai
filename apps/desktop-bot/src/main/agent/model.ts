// Talks to an AI model with tools. Three providers behind one small interface:
//   builtin   - the bot's own brain, running inside the bot (see brain.ts). The default.
//   anthropic - Claude through the Messages API (optional, needs a key)
//   ollama    - a model served by Ollama (optional, needs Ollama installed)
// The model only ever PROPOSES tool calls; the agent decides, through the gate, what really runs.

import { BrainConversation, callFromText, dropNulls, toFunctions, type Brain } from './brain';
import type { InputSchema } from './types';

export type ProviderName = 'builtin' | 'anthropic' | 'ollama';

export interface ModelConfig {
  provider: ProviderName;
  model: string;
  /** Anthropic key. Sent only in a request header, never logged or put in the body. */
  apiKey?: string;
  /** Ollama address, default http://127.0.0.1:11434 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The built-in brain (provider "builtin"). */
  brain?: Brain;
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

export const DEFAULT_MODELS: Record<ProviderName, string> = { builtin: 'qwen2.5-1.5b-instruct', anthropic: 'claude-sonnet-5-5', ollama: 'llama3.2' };
const MAX_TOKENS = 800;

export function openSession(cfg: ModelConfig, system: string, history: readonly Turn[], tools: readonly ModelTool[]): Session {
  if (cfg.provider === 'builtin') {
    if (!cfg.brain) throw new Error('The built-in brain is not available.');
    return new BuiltinSession(cfg.brain, system, history, tools);
  }
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

// --- The bot's own brain ------------------------------------------------------------------

class BuiltinSession implements Session {
  private readonly conv: BrainConversation;
  private readonly functions;
  private readonly names: ReadonlySet<string>;
  private counter = 0;

  constructor(private readonly brain: Brain, system: string, history: readonly Turn[], tools: readonly ModelTool[]) {
    this.conv = new BrainConversation(system, history);
    this.names = new Set(tools.map((t) => t.name));
    this.functions = tools.length ? toFunctions(tools.map((t) => ({ name: t.name, description: t.description, input: t.input }))) : undefined;
  }

  async step(): Promise<Step> {
    if (!this.brain.downloaded) {
      this.brain.prepare();
      const s = this.brain.status();
      throw new Error(s.state === 'error'
        ? `My brain could not download: ${s.detail} Fixed commands like "close notepad" still work.`
        : `I'm still getting my brain ready (${s.detail}). Fixed commands like "close notepad" or "switch to BRB" work right now.`);
    }
    const engine = await this.brain.ensure();
    let r = await engine.generate(this.conv.history, this.functions);
    const asText = r.calls.length === 0 ? callFromText(r.text, this.names) : null;
    if (asText) r = { text: '', calls: [{ name: asText.name, params: asText.params, raw: undefined }] };
    this.conv.record(r);
    return { text: r.text.trim(), calls: r.calls.map((c) => ({ id: `b${++this.counter}`, name: c.name, args: dropNulls(c.params) })) };
  }

  addResults(results: Array<{ call: ToolCall; content: string }>): void {
    this.conv.results(results.map((r) => r.content));
  }
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

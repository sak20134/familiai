// How the agent talks to the bot's brain: one that runs on this computer (brain.ts) or, when the
// person chooses it in Settings, their own chat API (api-brain.ts). Either way the brain only
// PROPOSES tool calls; the agent decides, through the gate, what really runs.

import { BrainConversation, callFromText, dropNulls, toFunctions, type Brain, type Engine } from './brain';
import type { InputSchema } from './types';

export type ModelConfig = { brain: Brain } | { engine: () => Promise<Engine> };

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

/** One conversation with tools. step() asks the brain; addResults() hands back what the tools did. */
export interface Session {
  step(): Promise<Step>;
  addResults(results: Array<{ call: ToolCall; content: string }>): void;
}

export function openSession(cfg: ModelConfig, system: string, history: readonly Turn[], tools: readonly ModelTool[]): Session {
  return new BrainSession(cfg, system, history, tools);
}

class BrainSession implements Session {
  private readonly conv: BrainConversation;
  private readonly functions;
  private readonly names: ReadonlySet<string>;
  private counter = 0;

  constructor(private readonly cfg: ModelConfig, system: string, history: readonly Turn[], tools: readonly ModelTool[]) {
    this.conv = new BrainConversation(system, history);
    this.names = new Set(tools.map((t) => t.name));
    this.functions = tools.length ? toFunctions(tools.map((t) => ({ name: t.name, description: t.description, input: t.input }))) : undefined;
  }

  async step(): Promise<Step> {
    const engine = await this.engine();
    let r = await engine.generate(this.conv.history, this.functions);
    const asText = r.calls.length === 0 ? callFromText(r.text, this.names) : null;
    if (asText) r = { text: '', calls: [{ name: asText.name, params: asText.params, raw: undefined }] };
    this.conv.record(r);
    return { text: r.text.trim(), calls: r.calls.map((c) => ({ id: `b${++this.counter}`, name: c.name, args: dropNulls(c.params) })) };
  }

  private async engine(): Promise<Engine> {
    if ('engine' in this.cfg) return this.cfg.engine();
    const brain = this.cfg.brain;
    if (!brain.downloaded) {
      // Normally the installer sets the brain up. If its files went missing, fetch them again.
      brain.prepare();
      const s = brain.status();
      throw new Error(s.state === 'error'
        ? `My brain could not be set up: ${s.detail} Fixed commands like "close notepad" still work.`
        : `I'm still setting up my brain (${s.detail}). Fixed commands like "close notepad" or "switch to BRB" work right now.`);
    }
    return brain.ensure();
  }

  addResults(results: Array<{ call: ToolCall; content: string }>): void {
    this.conv.results(results.map((r) => r.content));
  }
}

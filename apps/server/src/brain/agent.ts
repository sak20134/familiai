// The Family AI brain: one chat turn. Plans with the model (or the demo brain), calls tools through
// the safety layer, and replies honestly about what is done, waiting for approval, or failed.

import { ageModeFor } from '@familiai/core';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '../db/client';
import { newId } from '../security';
import { invokeTool, type ToolOutcome } from './actions';
import { demoSmallTalk, planDemo } from './demo';
import { TOOLS, type ToolContext } from './tools';

export interface BrainConfig {
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
}

export interface TurnResult {
  reply: string;
  outcomes: ToolOutcome[];
  demo: boolean;
}

const MAX_STEPS = 6;
const HISTORY = 12;

function systemPrompt(ctx: ToolContext): string {
  const u = ctx.user;
  const ai = u.aiName ?? 'Buddy';
  const name = ctx.member.nickname ?? u.displayName ?? 'there';
  const age = u.birthYear ? ageModeFor(Math.max(0, new Date().getUTCFullYear() - u.birthYear)) : 'adult';
  const tone = {
    under13: 'Use very simple words, short sentences, and be gentle and encouraging. Never discuss adult topics.',
    teen: 'Be friendly and direct. Keep content age-appropriate.',
    adult: 'Be warm, clear and efficient.',
    elder: 'Be patient and clear. Avoid jargon. Repeat key details.',
  }[age];
  return [
    `You are ${ai}, the family AI for this household. You call the user "${name}".`,
    u.botRole ? `Your personality: act like a ${u.botRole}.` : '',
    `Their family role is ${ctx.member.role}. ${tone}`,
    'Use tools to act. Some tools need a person to approve first; when a tool result says approval is needed, tell the user it is WAITING for their approval. Never say it is done.',
    'Money always needs approval, every time. If a tool fails, say exactly what failed. Never invent results.',
    'Keep replies short (1 to 4 sentences) unless asked for detail.',
  ].filter(Boolean).join(' ');
}

function outcomeLine(o: ToolOutcome): string {
  if (o.kind === 'needs_approval') return `I need your OK first: ${o.summary}. Tap Approve below when you're ready.`;
  if (o.kind === 'failed') return `That didn't work: ${o.text}`;
  return o.text;
}

async function loadHistory(ctx: ToolContext) {
  const rows = await ctx.db.select().from(schema.messages)
    .where(eq(schema.messages.memberId, ctx.member.id))
    .orderBy(desc(schema.messages.createdAt)).limit(HISTORY);
  return rows.reverse().filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
}

async function save(ctx: ToolContext, role: 'user' | 'assistant', content: string) {
  await ctx.db.insert(schema.messages).values({ id: newId('msg'), familyId: ctx.member.familyId, memberId: ctx.member.id, role, content });
}

async function demoTurn(ctx: ToolContext, message: string): Promise<TurnResult> {
  const plan = planDemo(message);
  if (!plan) {
    return { reply: demoSmallTalk(message, ctx.user.aiName ?? 'Buddy', ctx.member.nickname ?? ctx.user.displayName ?? 'there'), outcomes: [], demo: true };
  }
  const outcome = await invokeTool(ctx, plan.tool, plan.args);
  return { reply: outcomeLine(outcome), outcomes: [outcome], demo: true };
}

type ContentBlock = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
type ApiMessage = { role: 'user' | 'assistant'; content: string | unknown[] };

const toolDefs = () => TOOLS.map((t) => {
  const { $schema: _ignored, ...input_schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
  return { name: t.spec.name, description: `${t.spec.description} (risk: ${t.spec.risk})`, input_schema };
});

async function modelTurn(ctx: ToolContext, message: string, cfg: BrainConfig & { apiKey: string }): Promise<TurnResult> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const messages: ApiMessage[] = [...(await loadHistory(ctx)), { role: 'user', content: message }];
  const outcomes: ToolOutcome[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.model, max_tokens: 800, system: systemPrompt(ctx), tools: toolDefs(), messages }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`The AI model request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { content?: ContentBlock[]; stop_reason?: string };
    const content = json.content ?? [];
    const uses = content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    const text = content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('').trim();

    if (uses.length === 0) {
      // The model's words are never trusted on their own about actions: anything waiting or failed
      // is always stated by us, in fixed wording, after whatever the model said.
      const notices = outcomes.filter((o) => o.kind !== 'done').map(outcomeLine);
      const reply = [text || 'Okay.', ...notices].join('\n\n');
      return { reply, outcomes, demo: false };
    }

    messages.push({ role: 'assistant', content });
    const results = [];
    for (const u of uses) {
      const o = await invokeTool(ctx, u.name, u.input);
      outcomes.push(o);
      const resultText = o.kind === 'needs_approval'
        ? `WAITING FOR APPROVAL (request ${o.approvalId}): ${o.summary}. Nothing has been done yet.`
        : o.kind === 'failed' ? `FAILED: ${o.text}` : `DONE: ${o.text}`;
      results.push({ type: 'tool_result', tool_use_id: u.id, content: resultText, ...(o.kind === 'failed' ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: [...outcomes.map(outcomeLine), 'I stopped there to stay safe. Ask me to continue if needed.'].join('\n'), outcomes, demo: false };
}

export async function runTurn(ctx: ToolContext, message: string, cfg: BrainConfig): Promise<TurnResult> {
  await save(ctx, 'user', message);
  const result = cfg.apiKey ? await modelTurn(ctx, message, { ...cfg, apiKey: cfg.apiKey }) : await demoTurn(ctx, message);
  await save(ctx, 'assistant', result.reply);
  return result;
}

// Shapes shared by the agent, its tools and the safety gate.

import type { Role, ToolSpec } from '@familiai/core';

/** Who asked. The gate decides what they may do from their role, never from what the AI says. */
export interface Actor {
  id: string;
  name: string;
  role: Role;
  via: 'desktop' | 'phone' | 'cli' | 'rule';
}

/** JSON Schema for a tool's input, as the brain's tool grammar expects it. */
export interface InputSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; items?: { type: string }; enum?: readonly string[] }>;
  required?: readonly string[];
}

/**
 * What a tool reports back. `verified` is true only when something independent confirmed it
 * (OBS answered, the process list no longer shows the app). The bot never says more than this.
 */
export type ToolResult =
  | { ok: true; text: string; verified: boolean }
  | { ok: false; text: string };

export interface ToolDef {
  spec: ToolSpec;
  input: InputSchema;
  /** Shown on approval cards: what exactly will happen, in plain words. */
  summarize?(args: Record<string, unknown>): string;
  /** Only these roles may use the tool at all. Unset means everyone in the family. */
  roles?: readonly Role[];
  run(args: Record<string, unknown>, actor: Actor): Promise<ToolResult>;
}

export type Outcome =
  | { kind: 'done'; tool: string; text: string; verified: boolean }
  | { kind: 'needs_approval'; tool: string; id: string; summary: string }
  | { kind: 'blocked'; tool: string; text: string }
  | { kind: 'failed'; tool: string; text: string };

export interface PendingView {
  id: string;
  summary: string;
  risk: string;
  requestedBy: string;
  createdAt: number;
}

export interface Reply {
  text: string;
  /** Every action this request touched, with its real status. */
  outcomes: Outcome[];
  /** True when no AI model is set up and the bot only understood a fixed command. */
  offline: boolean;
}

export const ok = (text: string, verified = true): ToolResult => ({ ok: true, text, verified });
export const fail = (text: string): ToolResult => ({ ok: false, text });

export const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN);

// The one safety gate every action goes through: the AI model, the phone, the terminal and the
// family rules all use it. Rules live here in code, never in the prompt:
//   low    - runs straight away
//   medium - asks, unless AI Mode is on or the user gave a standing OK for that tool
//   high   - ALWAYS asks, every time
//   money  - ALWAYS asks, every time, even in AI Mode
// Children and guests can only run low-risk things; anything more waits for a parent.
// The kill switch stops everything until someone with authority resumes.

import { can, needsApproval, type Member, type Role } from '@familiai/core';
import type { Actor, PendingView, ToolDef } from './types';

export type GateDecision =
  | { kind: 'clear' }
  | { kind: 'needs_approval'; id: string; summary: string }
  | { kind: 'blocked'; reason: string };

interface Pending {
  id: string;
  tool: ToolDef;
  args: Record<string, unknown>;
  summary: string;
  requestedBy: Actor;
  createdAt: number;
}

export interface GateOptions {
  ttlMs?: number;
  now?: () => number;
  newId?: () => string;
}

const LIMITED: ReadonlySet<Role> = new Set<Role>(['child', 'guest']);

const asMember = (a: Actor): Member => ({ id: a.id, familyId: 'local', role: a.role });

/** Owners, admins and adults may OK actions. Money also needs the approve_money right. */
export function canApprove(actor: Actor, risk: string): boolean {
  const m = asMember(actor);
  if (!can(m, 'view_activity')) return false;
  return risk === 'money' ? can(m, 'approve_money') : true;
}

export class Gate {
  aiMode = false;
  readonly standing = new Set<string>();
  private killedBy: string | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private counter = 0;

  constructor(opts: GateOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `a${++this.counter}`);
  }

  get stopped(): boolean {
    return this.killedBy !== null;
  }

  /** Kill switch. Anyone in the family may pull it; it also throws away everything waiting. */
  stop(by: Actor): void {
    this.killedBy = by.name;
    this.pending.clear();
  }

  resume(by: Actor): boolean {
    if (!canApprove(by, 'high')) return false;
    this.killedBy = null;
    return true;
  }

  /** AI Mode lets medium-risk actions run without asking. Only adults may turn it on. */
  setAiMode(on: boolean, by: Actor): boolean {
    if (on && !can(asMember(by), 'use_ai_mode')) return false;
    if (on && LIMITED.has(by.role)) return false;
    this.aiMode = on;
    return true;
  }

  check(tool: ToolDef, args: Record<string, unknown>, actor: Actor): GateDecision {
    if (this.killedBy !== null) return { kind: 'blocked', reason: `Everything is stopped (${this.killedBy} pulled the stop switch). Say "resume" to continue.` };
    if (tool.roles && !tool.roles.includes(actor.role)) return { kind: 'blocked', reason: `${actor.name} (${actor.role}) is not allowed to ${tool.spec.description.toLowerCase()}` };

    const risk = tool.spec.risk;
    const limited = LIMITED.has(actor.role) && risk !== 'low';
    // AI Mode only counts when the person asking is allowed to use it.
    const aiMode = this.aiMode && can(asMember(actor), 'use_ai_mode') && !LIMITED.has(actor.role);
    if (!limited && !needsApproval(tool.spec, { aiMode, standing: this.standing })) return { kind: 'clear' };

    this.expire();
    const id = this.newId();
    const base = tool.summarize?.(args) ?? tool.spec.description;
    const summary = limited ? `${base} (asked by ${actor.name}, needs a parent's OK)` : base;
    this.pending.set(id, { id, tool, args, summary, requestedBy: actor, createdAt: this.now() });
    return { kind: 'needs_approval', id, summary };
  }

  /**
   * Claims a waiting request so it can run exactly once. Throws a plain-English reason when the
   * request is gone or the approver may not OK it.
   */
  claim(id: string, approver: Actor): Pending {
    this.expire();
    if (this.killedBy !== null) throw new Error('Everything is stopped. Resume first.');
    const p = this.pending.get(id);
    if (!p) throw new Error('That request is gone: it was already decided or it expired.');
    if (!canApprove(approver, p.tool.spec.risk)) throw new Error(`${approver.name} cannot approve this. Ask a parent or the owner.`);
    this.pending.delete(id); // removed before running, so a double tap cannot run it twice
    return p;
  }

  reject(id: string, by: Actor): string {
    const p = this.pending.get(id);
    if (!p) throw new Error('That request is gone: it was already decided or it expired.');
    // The person who asked may withdraw their own request; otherwise a parent decides.
    if (p.requestedBy.id !== by.id && !canApprove(by, p.tool.spec.risk)) throw new Error(`${by.name} cannot decide this.`);
    this.pending.delete(id);
    return p.summary;
  }

  list(): PendingView[] {
    this.expire();
    return [...this.pending.values()].map((p) => ({
      id: p.id,
      summary: p.summary,
      risk: p.tool.spec.risk,
      requestedBy: p.requestedBy.name,
      createdAt: p.createdAt,
    }));
  }

  private expire(): void {
    const now = this.now();
    for (const [id, p] of this.pending) if (now - p.createdAt > this.ttlMs) this.pending.delete(id);
  }
}

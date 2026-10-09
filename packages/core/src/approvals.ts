// Step 11 (and 12): risk tiers, approval flow, and honest result checking.
// Rule: money ALWAYS needs approval, even in AI Mode. We never report success unless verified.

import { can, type Member } from './roles';

export type Risk = 'low' | 'medium' | 'high' | 'money';

export interface ToolSpec {
  name: string;
  risk: Risk;
  description: string;
}

export interface Autonomy {
  /** User gave up-front permission for the AI to do work itself. */
  aiMode: boolean;
  /** Tool names the user pre-authorized (standing authorizations), medium risk only. */
  standing: ReadonlySet<string>;
}

export function needsApproval(tool: ToolSpec, autonomy: Autonomy): boolean {
  switch (tool.risk) {
    case 'low':
      return false;
    case 'medium':
      return !(autonomy.aiMode || autonomy.standing.has(tool.name));
    case 'high':
    case 'money':
      return true; // never skipped
  }
}

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executed' // ran, but not yet checked
  | 'verified' // ran AND the check passed
  | 'failed';

export interface ApprovalRequest {
  id: string;
  tool: ToolSpec;
  args: Record<string, unknown>;
  requestedBy: string;
  createdAt: number;
  status: ApprovalStatus;
  decidedBy?: string;
  error?: string;
  result?: unknown;
}

export interface FlowOptions {
  ttlMs?: number;
  now?: () => number;
  newId?: () => string;
}

export class ApprovalFlow {
  private readonly items = new Map<string, ApprovalRequest>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private counter = 0;

  constructor(opts: FlowOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => `apr_${++this.counter}`);
  }

  propose(tool: ToolSpec, args: Record<string, unknown>, requestedBy: string): ApprovalRequest {
    const req: ApprovalRequest = {
      id: this.newId(),
      tool,
      args,
      requestedBy,
      createdAt: this.now(),
      status: 'pending',
    };
    this.items.set(req.id, req);
    return req;
  }

  get(id: string): ApprovalRequest {
    const req = this.items.get(id);
    if (!req) throw new Error(`Unknown approval ${id}`);
    if (req.status === 'pending' && this.now() - req.createdAt > this.ttlMs) req.status = 'expired';
    return req;
  }

  approve(id: string, approver: Member): ApprovalRequest {
    const req = this.get(id);
    if (req.status !== 'pending') throw new Error(`Cannot approve a ${req.status} request`);
    const needed = req.tool.risk === 'money' ? 'approve_money' : 'chat';
    if (!can(approver, needed)) throw new Error(`${approver.role} cannot approve ${req.tool.risk} actions`);
    req.status = 'approved';
    req.decidedBy = approver.id;
    return req;
  }

  reject(id: string, approver: Member): ApprovalRequest {
    const req = this.get(id);
    if (req.status !== 'pending') throw new Error(`Cannot reject a ${req.status} request`);
    req.status = 'rejected';
    req.decidedBy = approver.id;
    return req;
  }

  /**
   * Run an approved request. The executor does the work; the verifier independently checks it.
   * Status becomes 'verified' only if both succeed. Failures keep the real error message.
   */
  async run(
    id: string,
    executor: (args: Record<string, unknown>) => Promise<unknown>,
    verifier: (result: unknown) => Promise<boolean>,
  ): Promise<ApprovalRequest> {
    const req = this.get(id);
    if (req.status !== 'approved') throw new Error(`Cannot run a ${req.status} request`);
    try {
      req.result = await executor(req.args);
      req.status = 'executed';
    } catch (err) {
      req.status = 'failed';
      req.error = err instanceof Error ? err.message : String(err);
      return req;
    }
    try {
      const ok = await verifier(req.result);
      if (ok) {
        req.status = 'verified';
      } else {
        req.status = 'failed';
        req.error = 'The action ran but the result check did not pass.';
      }
    } catch (err) {
      req.status = 'failed';
      req.error = `Result check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    return req;
  }
}

/** The only wording the AI may use about a request. Never claims more than is true. */
export function describeOutcome(req: ApprovalRequest): string {
  switch (req.status) {
    case 'pending':
      return 'Waiting for your approval.';
    case 'approved':
      return 'Approved, not run yet.';
    case 'rejected':
      return 'You rejected this. Nothing was done.';
    case 'expired':
      return 'This request expired. Nothing was done.';
    case 'executed':
      return 'It ran, but I have not confirmed the result yet.';
    case 'verified':
      return 'Done and confirmed.';
    case 'failed':
      return `It did not work: ${req.error ?? 'unknown error'}`;
  }
}

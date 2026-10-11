// Runs tools safely: checks inputs, asks for approval when the risk needs it, executes,
// verifies, and records the TRUE outcome. Approval rules are enforced here, outside the model.

import { can, describeOutcome, needsApproval, type ApprovalRequest, type Autonomy } from '@familiai/core';
import { and, eq } from 'drizzle-orm';
import { asMember, logActivity, type MemberRow } from '../context';
import { schema, type Db } from '../db/client';
import { newId } from '../security';
import { toolByName, type BrainTool, type ToolContext } from './tools';

export const APPROVAL_TTL_MS = 15 * 60_000;
export const NO_AUTONOMY: Autonomy = { aiMode: false, standing: new Set() };

export type ToolOutcome =
  | { kind: 'done'; tool: string; text: string }
  | { kind: 'failed'; tool: string; text: string }
  | { kind: 'needs_approval'; tool: string; approvalId: string; summary: string };

type ApprovalRow = typeof schema.approvals.$inferSelect;

/** Run one tool call coming from the brain (model or demo). */
export async function invokeTool(ctx: ToolContext, name: string, rawArgs: unknown, autonomy = ctx.autonomy ?? NO_AUTONOMY): Promise<ToolOutcome> {
  const tool = toolByName(name);
  if (!tool) return { kind: 'failed', tool: name, text: `Unknown tool "${name}".` };
  if (!can(asMember(ctx.member), tool.requires)) {
    return { kind: 'failed', tool: name, text: `Your family role (${ctx.member.role}) is not allowed to do that. Ask a parent or family admin.` };
  }
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { kind: 'failed', tool: name, text: `Bad input for ${name}: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  }
  const args = parsed.data as Record<string, unknown>;

  if (needsApproval(tool.spec, autonomy)) {
    const id = newId('apr');
    const summary = tool.summarize(args);
    await ctx.db.insert(schema.approvals).values({
      id, familyId: ctx.member.familyId, requestedBy: ctx.member.id, tool: name, risk: tool.spec.risk, summary, args,
    });
    await logActivity(ctx.db, ctx.member.familyId, ctx.member.id, 'approval_requested', `Asked for approval: ${summary}`);
    return { kind: 'needs_approval', tool: name, approvalId: id, summary };
  }
  return execute(ctx, tool, args);
}

async function execute(ctx: ToolContext, tool: BrainTool, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    const result = await tool.run(ctx, args);
    const ok = await tool.verify(ctx, result);
    if (!ok) return { kind: 'failed', tool: tool.spec.name, text: 'It ran, but the result check did not pass, so I am not calling it done.' };
    return { kind: 'done', tool: tool.spec.name, text: result.text };
  } catch (err) {
    return { kind: 'failed', tool: tool.spec.name, text: err instanceof Error ? err.message : String(err) };
  }
}

/** Roles trusted to approve their own medium/high-risk requests. Kids, teens and guests need someone else. */
const SELF_APPROVERS = new Set(['owner', 'admin', 'adult', 'elder']);

/**
 * Who may decide:
 * - money: anyone with approve_money (adult, admin, owner), every time;
 * - anything else: a family owner/admin, or the requester themselves if they are a trusted adult role.
 */
export function mayDecide(approver: MemberRow, row: ApprovalRow): boolean {
  if (approver.familyId !== row.familyId) return false;
  const m = asMember(approver);
  if (row.risk === 'money') return can(m, 'approve_money');
  if (m.role === 'owner' || m.role === 'admin') return true;
  return approver.id === row.requestedBy && SELF_APPROVERS.has(m.role);
}

export function toRequest(row: ApprovalRow, now = Date.now()): ApprovalRequest {
  const tool = toolByName(row.tool);
  const expired = row.status === 'pending' && now - row.createdAt.getTime() > APPROVAL_TTL_MS;
  return {
    id: row.id,
    tool: tool?.spec ?? { name: row.tool, risk: row.risk as ApprovalRequest['tool']['risk'], description: '' },
    args: row.args as Record<string, unknown>,
    requestedBy: row.requestedBy,
    createdAt: row.createdAt.getTime(),
    status: expired ? 'expired' : (row.status as ApprovalRequest['status']),
    ...(row.decidedBy ? { decidedBy: row.decidedBy } : {}),
    ...(row.error ? { error: row.error } : {}),
    result: row.result ?? undefined,
  };
}

export type DecideError = 'not_found' | 'forbidden' | 'not_pending';

export async function decide(
  db: Db,
  approver: MemberRow,
  approvalId: string,
  decision: 'approve' | 'reject',
  loadContext: (requesterId: string) => Promise<ToolContext | null>,
): Promise<{ ok: true; row: ApprovalRow; message: string } | { ok: false; error: DecideError; message: string }> {
  const [row] = await db.select().from(schema.approvals)
    .where(and(eq(schema.approvals.id, approvalId), eq(schema.approvals.familyId, approver.familyId)));
  if (!row) return { ok: false, error: 'not_found', message: 'No such approval request.' };
  if (!mayDecide(approver, row)) {
    return { ok: false, error: 'forbidden', message: row.risk === 'money' ? 'Only an adult or admin can approve money.' : 'You cannot decide on this request.' };
  }
  const current = toRequest(row);
  if (current.status !== 'pending') {
    if (current.status === 'expired' && row.status === 'pending') {
      await db.update(schema.approvals).set({ status: 'expired' }).where(eq(schema.approvals.id, row.id));
    }
    return { ok: false, error: 'not_pending', message: describeOutcome(current) };
  }

  // Claim it atomically so a double tap cannot run it twice.
  const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
  const [claimed] = await db.update(schema.approvals)
    .set({ status: nextStatus, decidedBy: approver.id, decidedAt: new Date() })
    .where(and(eq(schema.approvals.id, row.id), eq(schema.approvals.status, 'pending')))
    .returning();
  if (!claimed) return { ok: false, error: 'not_pending', message: 'Someone already decided this request.' };

  if (decision === 'reject') {
    await logActivity(db, row.familyId, approver.id, 'approval_rejected', `Rejected: ${row.summary}`);
    return { ok: true, row: claimed, message: describeOutcome(toRequest(claimed)) };
  }

  // From here on, every path must end in a final status ('verified' or 'failed'), never stuck at 'approved'.
  let outcome: ToolOutcome;
  try {
    const tool = toolByName(row.tool);
    const ctx = await loadContext(row.requestedBy);
    if (!tool || !ctx) {
      outcome = { kind: 'failed', tool: row.tool, text: 'The person who asked is no longer in the family.' };
    } else if (!can(asMember(ctx.member), tool.requires)) {
      // Their role may have changed since they asked.
      outcome = { kind: 'failed', tool: row.tool, text: `The person who asked (${ctx.member.role}) is no longer allowed to do this.` };
    } else {
      outcome = await execute(ctx, tool, row.args as Record<string, unknown>);
    }
  } catch (err) {
    outcome = { kind: 'failed', tool: row.tool, text: err instanceof Error ? err.message : 'Unexpected error.' };
  }

  const [final] = await db.update(schema.approvals)
    .set(outcome.kind === 'done'
      ? { status: 'verified', result: { text: outcome.text }, error: null }
      : { status: 'failed', error: outcome.kind === 'failed' ? outcome.text : 'Unexpected state.' })
    .where(eq(schema.approvals.id, row.id))
    .returning();
  await logActivity(db, row.familyId, approver.id, outcome.kind === 'done' ? 'approval_done' : 'approval_failed',
    `${outcome.kind === 'done' ? 'Approved and done' : 'Approved but failed'}: ${row.summary}`);
  return { ok: true, row: final!, message: outcome.kind === 'done' ? `Done and confirmed: ${outcome.text}` : describeOutcome(toRequest(final!)) };
}

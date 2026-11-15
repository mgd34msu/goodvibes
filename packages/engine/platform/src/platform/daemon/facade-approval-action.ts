import type { ApprovalBroker } from '../control-plane/approval-broker.js';

interface InteractiveApprovalContext {
  readonly broker: Pick<ApprovalBroker, 'claimApproval' | 'resolveApproval' | 'cancelApproval'>;
  parseBody(request: Request): Promise<Record<string, unknown> | Response | null>;
  actor(request: Request): string;
  /** The surface the answer came from; absent means the web API. */
  surface?(request: Request): string;
  record(request: Request, path: string, response: Response): Response;
}

/** The facade's explicit interactive button path, not a generic callback report. */
export async function handleInteractiveApprovalAction(
  context: InteractiveApprovalContext,
  approvalId: string,
  action: 'claim' | 'approve' | 'deny' | 'cancel',
  req: Request,
): Promise<Response> {
  const body = await context.parseBody(req);
  // A body that could not be read must not become an approve/deny without its note or remember choice.
  if (body instanceof Response) return body;
  const payload = body ?? {};
  const actor = context.actor(req);
  const surface = context.surface?.(req) ?? 'web';
  const note = typeof payload.note === 'string' ? payload.note : undefined;
  if (action === 'claim') {
    const approval = await context.broker.claimApproval(approvalId, actor, surface, note);
    return approval
      ? context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
      : context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
  }
  if (action === 'cancel') {
    const approval = await context.broker.cancelApproval(approvalId, actor, surface, note);
    return approval
      ? context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
      : context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
  }
  const approval = await context.broker.resolveApproval(approvalId, {
    approved: action === 'approve',
    // This path is reached from a known button action. The separate HTTP
    // route also accepts legacy generic callback reports and cannot infer it.
    disposition: action === 'approve' ? 'approved' : 'denied',
    remember: typeof payload.remember === 'boolean' ? payload.remember : false,
    actor,
    actorSurface: surface,
    note,
  });
  return approval
    ? context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ approval }))
    : context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({ error: 'Unknown approval' }, { status: 404 }));
}

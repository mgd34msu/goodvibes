import type { ApprovalBroker } from '../control-plane/approval-broker.js';
import type { ChannelPolicyManager } from '../channels/policy-manager.js';
import { channelSenderActor } from '../channels/policy-manager.js';
import { admitEffects } from '../security/effect-authority.js';
import type { ChannelSurface } from '../channels/types.js';
import { assertCanConfirm } from '../gate/surface-authority.js';

interface InteractiveApprovalContext {
  readonly broker: Pick<ApprovalBroker, 'claimApproval' | 'resolveApproval' | 'cancelApproval'>;
  /** The channel policies that say who owns a chat surface. */
  readonly channelPolicy: Pick<ChannelPolicyManager, 'getPolicy'>;
  /** Who pressed the button, when it came from a chat surface whose signature the daemon already verified; absent for the web API. */
  readonly interaction?: { readonly surface: string; readonly userId: string } | undefined;
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
  const interaction = context.interaction;
  if (interaction) {
    // A button pressed in a chat answers only from a command surface or as that channel's recorded owner.
    if (!interaction.userId) {
      return context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({
        error: `The ${interaction.surface} button press did not say who pressed it, so it cannot answer an approval.`,
        code: 'APPROVAL_ANSWER_REFUSED', state: 'pending',
        reason: `The ${interaction.surface} payload carried no sender id, so the owner check cannot run.`,
        next: ['Answer the approval in the web app or a terminal app, or with an approval reply from the channel owner\'s account'],
      }, { status: 403 }));
    }
    let fromChannelOwner = false;
    try {
      const sender = channelSenderActor({ policy: context.channelPolicy.getPolicy(interaction.surface as ChannelSurface) }, interaction.surface, interaction.userId);
      fromChannelOwner = admitEffects(sender, ['approval.answer']).kind === 'allowed';
    }
    catch { fromChannelOwner = false; }
    const verdict = assertCanConfirm(interaction.surface, { fromChannelOwner });
    if (!verdict.allowed) {
      return context.record(req, `/api/approvals/${approvalId}/${action}`, Response.json({
        error: `${verdict.problem} ${verdict.fix}`, code: 'APPROVAL_ANSWER_REFUSED', state: 'pending',
        reason: verdict.problem, next: [verdict.fix],
      }, { status: 403 }));
    }
  }
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

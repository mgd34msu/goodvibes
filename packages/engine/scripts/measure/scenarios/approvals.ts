/**
 * Approval scenarios: a wire raiser's whole round (raise, approve at the
 * revision it read, release its hold as the receipt), and reading 50 open
 * approvals with their readings.
 */
import { createShellPathService } from '../../../platform/src/platform/runtime/shell-paths.ts';
import { ApprovalBroker } from '../../../platform/src/platform/control-plane/approval-broker.ts';
import { localApprovalActions } from '../../../platform/src/platform/control-plane/approval-actions.ts';
import { decisions } from './stores.ts';
import { assertOutcome, type Instance, type Scenario } from '../harness.ts';

const P = 'packages/engine/platform/src/platform';
const PRIOR = 50;
const ask = (callId: string) => ({
  callId, tool: 'exec', args: { command: `git push origin ${callId}` }, category: 'execute' as const,
  analysis: { classification: 'command', riskLevel: 'medium' as const, summary: `Push ${callId}`, reasons: [] },
});
const WIRE = { raisedVia: 'approvals.raise', raisedByPrincipal: 'measure' };

const approvalRaiseApprove: Scenario = {
  name: 'approval-raise-approve',
  drives: `A wire raiser's round on the approvals log holding ${PRIOR} earlier answered approvals: approvals.raise (with its hold), approve at the raised revision, then the raiser releases its hold (the receipt).`,
  entries: [`${P}/control-plane/approval-broker.ts ApprovalBroker.raiseApproval`, `${P}/control-plane/approval-broker.ts ApprovalBroker.resolveApproval`, `${P}/control-plane/approval-broker.ts ApprovalBroker.releaseApproval`],
  async setup(env): Promise<Instance> {
    const judgment = decisions(env, 'daemon');
    const shellPaths = createShellPathService({ workingDirectory: env.workspace, homeDirectory: env.home });
    const broker = new ApprovalBroker({ storePath: shellPaths.resolveProjectPath('daemon', 'control-plane', 'approvals.jsonl') });
    for (let i = 0; i < PRIOR; i++) {
      const raised = await broker.raiseApproval({ request: ask(`prior-${i}`), metadata: WIRE });
      await broker.resolveApproval(raised.approval.id, { approved: true, actor: 'owner', expectedRevision: raised.approval.revision });
      await broker.releaseApproval(raised.approval.id, { actor: 'measure', holdId: raised.holdId });
    }
    return {
      async op(run) {
        const raised = await broker.raiseApproval({ request: ask(`measured-${run}-${Date.now()}`), metadata: WIRE });
        const decided = await broker.resolveApproval(raised.approval.id, { approved: true, actor: 'owner', actorSurface: 'web', expectedRevision: raised.approval.revision });
        assertOutcome(decided.applied, `the approve at the raised revision was refused: ${decided.applied ? '' : decided.refusal.code}`);
        const released = await broker.releaseApproval(raised.approval.id, { actor: 'measure', holdId: raised.holdId });
        assertOutcome(released.applied && released.record.requester.kind === 'wire' && released.record.requester.holds.every((hold) => hold.releasedAt !== undefined),
          'the release did not record the receipt');
      },
      dispose() { judgment.restore(); },
    };
  },
};

const approvalList50: Scenario = {
  name: 'approval-list-50',
  drives: 'approvals.list as a route reads it: 50 open approvals, each with its reading for an admin viewer.',
  entries: [`${P}/control-plane/approval-actions.ts localApprovalActions.list`, `${P}/control-plane/approval-lifecycle.ts readApproval`],
  async setup(env): Promise<Instance> {
    const judgment = decisions(env, 'daemon');
    const shellPaths = createShellPathService({ workingDirectory: env.workspace, homeDirectory: env.home });
    const broker = new ApprovalBroker({ storePath: shellPaths.resolveProjectPath('daemon', 'control-plane', 'approvals.jsonl') });
    for (let i = 0; i < PRIOR; i++) await broker.raiseApproval({ request: ask(`open-${i}`), metadata: WIRE });
    const actions = localApprovalActions(broker);
    const viewer = actions.viewerOf(undefined);
    return {
      async op() {
        const rows = actions.list(viewer, PRIOR);
        assertOutcome(rows.length === PRIOR && rows.every((row) => row.reading.phase === 'waiting'), `listed ${rows.length} rows`);
      },
      dispose() { judgment.restore(); },
    };
  },
};

export const scenarios: Scenario[] = [approvalRaiseApprove, approvalList50];

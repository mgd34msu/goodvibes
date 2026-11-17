/**
 * Who decides a sandboxed command's host access follows `permissions.mode`,
 * the one rule for every ask: with the owner deciding (ask-me, or jev-decides
 * with no working decision model) the owner is asked on the approval card,
 * annotated by the advisory reading per `sandbox.judgment`; otherwise the
 * call's own recorded admission decides. Either way the exec gets one live
 * permit for the final spawn.
 */
import { logger } from '../../utils/logger.js';
import type { ConfigManager } from '../../config/manager.js';
import type { FeatureFlagManager } from '../feature-flags/index.js';
import type { PermissionPromptDecision, PermissionPromptRequest } from '../../permissions/prompt.js';
import {
  createSandboxEscalationApprovalHandler,
  type SandboxEscalationJudgment,
} from './sandbox-escalation.js';

import { currentExternalOperationSource } from '../../permissions/external-operation-scope.js';
import { decisionModelReady, effectivePermissionMode } from '../../gate/presets.js';
import type { SandboxEscalationExecution, SandboxEscalationPermit } from '../../tools/exec/sandbox.js';
import { admitSandboxEscalation } from './autonomous-sandbox-escalation.js';
import type { AutonomousToolPromptHost } from './autonomous-tool-prompts.js';
export type ExecSandboxEscalationHandler = import('../../tools/exec/sandbox.js').SandboxEscalationHandler;

/** The broker seam this wiring routes through. */
export interface EscalationWiringDeps {
  readonly autonomousHost?: AutonomousToolPromptHost | undefined;
  readonly requestApproval: (input: {
    readonly request: PermissionPromptRequest;
    readonly routeId?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }) => Promise<PermissionPromptDecision>;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'>;
}

/** Build the canonical exact-plan handler, preserving standalone advisory compatibility. */
export function buildSandboxEscalationHandler(deps: EscalationWiringDeps): ExecSandboxEscalationHandler {
  // Read per escalation, not once at build: turning auto-approve off (or the advisory off) must hold for the next ask.
  const judgmentNow = (): SandboxEscalationJudgment | undefined => deps.featureFlags.isEnabled('sandbox-model-judgment')
    ? {
        config: { enabled: true, autoApprove: deps.configManager.get('sandbox.judgment') === 'auto-approve' },
        onReceipt: (r) => logger.info('[sandbox-judgment] receipt', {
          command: r.command, verdict: r.verdict, outcome: r.outcome, riskProbability: r.riskProbability,
        }),
      }
    : undefined;

  const ownerDecides = (): boolean => {
    const config = deps.configManager;
    return effectivePermissionMode(config.get('permissions.mode'), config.get('behavior.autoApprove') === true, decisionModelReady({
      policy: config.get('judgment.policy'), endpoint: config.get('judgment.endpoint'), model: config.get('judgment.model'),
      keySource: config.get('judgment.keySource'), keyName: config.get('judgment.keyName'),
    })) === 'ask-me';
  };

  return async (input, execution) => {
    if (deps.autonomousHost && !ownerDecides()) return admitSandboxEscalation(deps.autonomousHost, input, execution);
    const seam = createSandboxEscalationApprovalHandler(deps.requestApproval, judgmentNow());
    const approved = (await seam({ sandbox: 'exec-sandbox', ...input })).approved;
    if (!approved) return false;
    // Inside a model turn the exec spawns only on a live permit; the owner's yes is that permit.
    return currentExternalOperationSource() ? ownerPermit(execution) : true;
  };
}

/** The owner's approval as the permit the exec claims immediately before it spawns. */
function ownerPermit(execution?: SandboxEscalationExecution): SandboxEscalationPermit {
  const signal = execution?.signal ?? new AbortController().signal;
  let closed = false;
  const assertCurrent = (): void => {
    if (closed) throw new Error('Sandbox escalation approval closed');
    signal.throwIfAborted(); execution?.assertCurrent();
  };
  return Object.freeze({ signal, assertCurrent, claim: assertCurrent, close() { closed = true; } });
}

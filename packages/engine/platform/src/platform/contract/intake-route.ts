/**
 * Intake of a person's turn (docs/design/contract-runner.md 10.3). The
 * composer shows the session's open contract question (`openEscalation`)
 * above the input; when the person answers it there, the message carries the
 * question's escalation id and goes to `runner.reply` as the answer, and the
 * turn ends there. Code decides this from the message and the open question:
 * no model reads the turn first. A message sent without the id, or after the
 * person dismissed the question, is an ordinary turn. The conversation model
 * may still start a contract through the agent tool.
 *
 * `toolResultStartedContract` reads the agent tool's fixed result field
 * `contractStarted: true` (a format the tool itself writes, read as code).
 */
import type { ToolResult } from '../types/tools.js';
import { isRecord } from '../utils/record-coerce.js';
import { OwnerReplyRefusedError, type OwnerReplyOutcome } from './escalation.js';
import type { ContractRunner } from './runner.js';
import type { ContractView, Escalation } from './types.js';

export type TurnIntakeOutcome =
  /** The turn goes on as a normal conversation turn. */
  | { readonly kind: 'turn' }
  /** A contract started for the turn's text; the turn ends. */
  | { readonly kind: 'started'; readonly contractId: string; readonly ownerAgentId: string }
  /** The turn's text answered an open escalation; the turn ends. */
  | { readonly kind: 'replied'; readonly contractId: string; readonly outcome: OwnerReplyOutcome; readonly failurePause?: true };

export interface ContractIntake {
  /** Answers the named open question with the turn's text; see the module comment. */
  intake(turn: { readonly text: string; readonly sessionId: string; readonly signal?: AbortSignal | undefined; readonly answersEscalationId?: string | undefined }): Promise<TurnIntakeOutcome>;
}

export interface ContractIntakeDeps {
  readonly getSelectedModel?: (() => Pick<import('../providers/registry-types.js').ModelDefinition, 'id' | 'provider' | 'registryKey' | 'displayName'>) | undefined;
  readonly runner: Pick<ContractRunner, 'start' | 'list' | 'reply' | 'nativeMode'>;
  /** The project a turn's contract works in. */
  readonly projectRoot: string;
}

/** The session's newest open escalation, with its contract. */
export function openEscalation(contracts: readonly ContractView[]): { readonly contract: ContractView; readonly escalation: Escalation } | null {
  let newest: { readonly contract: ContractView; readonly escalation: Escalation } | null = null;
  for (const contract of contracts) {
    if (contract.nativeSource !== undefined) continue;
    for (const escalation of contract.escalations) {
      if (escalation.resolvedAt !== undefined) continue;
      if (newest === null || escalation.at > newest.escalation.at) newest = { contract, escalation: escalation as Escalation };
    }
  }
  return newest;
}

export function createContractIntake(deps: ContractIntakeDeps): ContractIntake {
  return {
    async intake(turn) {
      turn.signal?.throwIfAborted();
      if (turn.answersEscalationId === undefined) return { kind: 'turn' };
      if (deps.runner.nativeMode === true) throw new Error('Native intake requires source-bearing host admission; legacy owner replies are unavailable');
      const waiting = openEscalation(deps.runner.list({ sessionId: turn.sessionId }));
      // The question was answered elsewhere or its contract ended: the message is an ordinary turn.
      if (waiting === null || waiting.escalation.id !== turn.answersEscalationId) return { kind: 'turn' };
      let outcome: OwnerReplyOutcome;
      try {
        outcome = await deps.runner.reply(waiting.contract.id, waiting.escalation.id, turn.text);
      } catch (error) {
        // Each refusal says nothing was applied, so the turn goes on as a normal message.
        if (error instanceof OwnerReplyRefusedError && (error.refusal === 'ended' || error.refusal === 'not-open' || error.refusal === 'already-reading')) return { kind: 'turn' };
        throw error;
      }
      return { kind: 'replied', contractId: waiting.contract.id, outcome, ...(waiting.escalation.failurePause === true ? { failurePause: true as const } : {}) };
    },
  };
}

/** Whether an agent tool result says it started a contract (the tool's own `contractStarted` field). */
export function toolResultStartedContract(result: ToolResult): boolean {
  if (!result.success || result.output === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(result.output);
    return isRecord(parsed) && parsed['contractStarted'] === true;
  } catch {
    return false;
  }
}

/** The line a turn that ended at intake leaves in the conversation. */
export function describeIntake(outcome: Exclude<TurnIntakeOutcome, { kind: 'turn' }>): string {
  if (outcome.kind === 'started') {
    return `[Contract] Contract ${outcome.contractId} took this request; its answer arrives when every acceptance criterion is checked and met.`;
  }
  // A failed-turn question is answered "retry" or "cancel", not read as approval, so it says what was done.
  if (outcome.failurePause === true) {
    return `[Contract] Your answer to contract ${outcome.contractId} (${outcome.outcome.escalationId}) was taken as ${outcome.outcome.action === 'stopped' ? 'cancel: the contract is cancelled' : 'retry: the turn is retrying'}.`;
  }
  const next = outcome.outcome.nextEscalationId === undefined ? '' : ` It asks again (${outcome.outcome.nextEscalationId}).`;
  return `[Contract] Your reply to contract ${outcome.contractId} (${outcome.outcome.escalationId}) was read as ${outcome.outcome.reading}: ${outcome.outcome.action}.${next}`;
}

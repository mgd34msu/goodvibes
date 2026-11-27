import { readProtocolRequest, type CapturedProtocolRequest } from './protocol-request.js';
import { captureExternalRequestEvidence } from './external-request-evidence.js';
/** ACP/MCP use the same recorded autonomous admission as native tools. No human fallback. */
import { randomUUID } from 'node:crypto';
import type { JudgmentPort } from '@goodvibes/judgment';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { captureCurrentAutonomousChoices, captureCurrentAutonomousSourceFrame, type AutonomousToolSource } from './autonomous.js';
import { awaitPermission } from './cancellation.js';
import { decideInProject } from './call-project.js';
import { assertCurrentExternalAdmission, claimExternalAdmission, closeExternalAdmission, type PermissionManager } from './manager.js';
import type { ToolExecutionEffect } from '../tools/registry.js';
import type { WorkspaceTrustManager } from '../runtime/workspace-trust.js';

/** Trusted transport-owned lifetime; never reconstructed from remote protocol params. */
export interface ExternalRequestScope {
  readonly connectionId: string;
  readonly destination: string;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  /**
   * The session the connection asks for, where it has one: remembered answers
   * are read and written under it, never under another session's or the
   * session-less key.
   */
  readonly sessionId?: string | undefined;
  /**
   * The folder the connection works in, set by the transport from what it
   * started (never from the peer's words): the request is decided for that
   * project (call-project.ts), its rules, its trust and its answers.
   */
  readonly workingDirectory?: string | undefined;
}

export interface ExternalPermissionHost {
  /** Explicit null means this host has no separate workspace policy. Missing fails closed. */
  readonly workspaceTrust?: Pick<WorkspaceTrustManager, 'prepareAutonomousConstraint'> | null | undefined;
  readonly workspaceRoot?: string | undefined;
  /** Trusted composition resolver for the actual process cwd, never peer supplied. */
  readonly workspaceTrustFor?: ((cwd: string) => Pick<WorkspaceTrustManager, 'prepareAutonomousConstraint'> | null | undefined) | undefined;
  readonly port: JudgmentPort;
  /** `retireAutonomousSource` lets a settled request release its bookkeeping; a host without it keeps it for its lifetime. */
  readonly permissionManager: Pick<PermissionManager, 'admitAutonomous'> & Partial<Pick<PermissionManager, 'retireAutonomousSource'>>;
  readonly config: { onDidInvalidate(listener: () => void): () => void };
  readonly signal: AbortSignal;
}

/** The original host goal and facts, scoped to an actual pending operation. */
export interface ExternalOperationSource {
  readonly operationId?: string | undefined;
  readonly sourceOf: () => AutonomousToolSource;
  /** Already-authorized, exact possible form answers; Jev may select, never invent them. */
  readonly inputFacts?: readonly Readonly<Record<string, unknown>>[] | undefined;
  readonly assertCurrent: () => void;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Admit one external request. The operation's source is captured once and
 * frozen: it changes only together with the operation, whose own
 * `assertCurrent` and signal say so, so nothing re-captures or deep-compares it.
 * A caller that already opened the admission scope (openAutonomousAdmission)
 * passes it as `opened`, and its subscription, signal and source are used as
 * they are instead of a second set.
 */
export async function admitExternalRequest(host: ExternalPermissionHost, transport: ExternalRequestScope,
  operation: ExternalOperationSource, input: { readonly tool: string; readonly args: Record<string, unknown>; readonly effect?: ToolExecutionEffect | undefined; readonly supportingDecisionIds?: readonly string[]; readonly serverPolicy?: Readonly<Record<string, unknown>>; readonly protocolSubject?: CapturedProtocolRequest;
    /** The owner's own rule asks them about this request (an `ask-on-risk` MCP server called outside its scope): one sentence, shown to them. */
    readonly ownerAsk?: string | undefined;
    /** The request's own sender put it to its answerer, who said yes: plan mode and deny rules still refuse it, nobody is asked. */
    readonly ownerConfirmed?: boolean | undefined },
  opened?: { readonly signal: AbortSignal; readonly source: AutonomousToolSource }) {
  const externalRequestEvidence = captureExternalRequestEvidence({ destination: transport.destination, ...(input.serverPolicy ? { serverPolicy: input.serverPolicy } : {}) });
  let unsubscribe: () => void = () => {};
  let signal: AbortSignal;
  if (opened) {
    signal = transport.signal === opened.signal ? opened.signal : AbortSignal.any([opened.signal, transport.signal]);
  } else {
    const invalidation = new AbortController();
    unsubscribe = host.config.onDidInvalidate(() => invalidation.abort());
    signal = AbortSignal.any([host.signal, transport.signal, invalidation.signal, ...(operation.signal ? [operation.signal] : [])]);
  }
  const assertCurrent = (): void => { signal.throwIfAborted(); transport.assertCurrent(); operation.assertCurrent(); };
  try {
    assertCurrent();
    const source = opened?.source ?? captureCurrentAutonomousSourceFrame(operation.sourceOf()).source;
    captureCurrentAutonomousChoices({ resumeConditions: [{ id: transport.connectionId, revision: 'connection' }] });
    const protocol = input.protocolSubject ? readProtocolRequest(input.protocolSubject) : undefined;
    const args = captureOwnedJson(protocol ? { ...input.args, protocolRequest: protocol.meaning } : input.args) as Record<string, unknown>;
    const sourceOf = () => { assertCurrent(); return source; };
    const requestId = randomUUID();
    const admission = await awaitPermission(() => decideInProject(transport.workingDirectory, () => host.permissionManager.admitAutonomous(requestId, input.tool, args, {
      externalRequestEvidence, signal, sourceOf, assertPrepared: assertCurrent, ...(input.supportingDecisionIds ? { preparationDecisionIds: input.supportingDecisionIds } : {}),
      schemaRevision: protocol?.revision ?? requestId,
      decoratePort: () => host.port,
      sessionId: transport.sessionId,
      ...(input.ownerAsk !== undefined ? { ownerAsk: input.ownerAsk } : {}),
      ...(input.ownerConfirmed === true ? { ownerConfirmed: true } : {}),
    })), signal);
    assertCurrent();
    let finished = false, claimed = false;
    // Every request id is fresh, so nothing else ever releases what this admission recorded.
    const settle = () => { finished = true; unsubscribe(); host.permissionManager.retireAutonomousSource?.(requestId); };
    // The checks after the decision (the transport's last one, immediately before its answer goes out, and the claim)
    // run for the same project the request was decided for: outside it they read another project's settings and
    // refused every decided answer as "Permission configuration changed while deciding".
    const inItsProject = <T>(work: () => T): T => decideInProject(transport.workingDirectory, work);
    const retainedCurrent = () => inItsProject(() => {
      if (finished && input.effect) throw new Error('External admission is closed');
      assertCurrent();
      if (claimed && input.effect) assertCurrentExternalAdmission(admission, host.permissionManager, input.effect);
    });
    return {
      result: admission.result,
      assertCurrent: retainedCurrent,
      claim() {
        if (finished || claimed) throw new Error('External response already consumed');
        inItsProject(() => {
          assertCurrent();
          if (input.effect) claimExternalAdmission(admission, host.permissionManager, input.effect);
          else admission.claim();
        });
        claimed = true; retainedCurrent();
        // Existing protocol owners consume their response at claim. Native
        // multi-effect owners opt into the retained issuer lifetime explicitly.
        if (!input.effect) settle();
      },
      close() {
        if (!finished) {
          try {
            if (input.effect && admission.result.approved) closeExternalAdmission(admission, host.permissionManager);
          } finally { settle(); }
        }
      },
    };
  } catch (error) { unsubscribe(); throw error; }
}

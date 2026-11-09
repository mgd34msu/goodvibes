/**
 * grants.ts, pre-registered, owner-confirmed action grants.
 *
 * A firing trigger runs an agent turn or a grant registered here. It never
 * composes a new command at fire time: arbitrary shell on an unattended event
 * is the one path with no person in the loop. A grant closes that gap by moving
 * the human moment forward, the exact argv is written down and confirmed while
 * a person is present. Fresh grants carry an opaque revision and retain the
 * exact approved argv/cwd that must still match when the trigger fires.
 *
 * At fire time the original revision and approved action must match. Editing the grant after the
 * fact therefore breaks every trigger pinned to it, which is the intended
 * behaviour: the operator re-confirms rather than silently inheriting a
 * different command than the one they approved.
 */

import { createHash, randomUUID } from 'node:crypto';
import { validateArgv } from './validation.js';
import type { ActionGrantAction, TriggerActionGrant, TriggerApprovedAction } from './types.js';

/**
 * Canonical digest input. Covers everything that decides what actually runs,
 * the executable, its arguments and its working directory. The description and
 * timestamps are deliberately excluded so a typo fix in prose does not
 * invalidate a grant, while any change to the command does.
 */
function canonicalGrant(grant: Pick<TriggerActionGrant, 'command' | 'args' | 'cwd'>): string {
  return JSON.stringify({
    command: grant.command,
    args: [...grant.args],
    cwd: grant.cwd ?? null,
  });
}

/** Published checksum representation for reading earlier saved grants only.
 * Fresh grants and their fire-time checks use approvedAction plus revision. */
export function computeGrantDigest(grant: Pick<TriggerActionGrant, 'command' | 'args' | 'cwd'>): string {
  return createHash('sha256').update(canonicalGrant(grant)).digest('hex');
}

const GRANT_REVISION = /^grant-revision-v1:[a-p]{32}$/;
function validApproval(approval: TriggerApprovedAction): boolean {
  return approval !== null && typeof approval === 'object' && !Array.isArray(approval)
    && Object.keys(approval).length === 4 && approval.version === 1 && typeof approval.command === 'string'
    && Array.isArray(approval.args) && approval.args.every(argument => typeof argument === 'string')
    && (approval.cwd === null || typeof approval.cwd === 'string');
}
function captureApproval(grant: TriggerActionGrant): TriggerApprovedAction {
  return Object.freeze({ version: 1, command: grant.command, args: Object.freeze([...grant.args]), cwd: grant.cwd ?? null });
}
function sameAction(left: Pick<TriggerActionGrant, 'command' | 'args' | 'cwd'>,
  right: { readonly command: string; readonly args: readonly string[]; readonly cwd?: string | null | undefined }): boolean {
  return left.command === right.command && (left.cwd ?? null) === (right.cwd ?? null)
    && Array.isArray(left.args) && Array.isArray(right.args)
    && left.args.length === right.args.length && left.args.every((argument, index) => argument === right.args[index]);
}

export interface RegisterGrantInput {
  readonly id: string;
  readonly description: string;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  /** Who confirmed it. Recorded so the approval has a name attached. */
  readonly confirmedBy: string;
  readonly now?: number | undefined;
}

export function createActionGrant(input: RegisterGrantInput, previous?: TriggerActionGrant): TriggerActionGrant {
  const { command, args } = validateArgv(input.command, input.args, 'grant');
  if (!input.confirmedBy || input.confirmedBy.trim().length === 0) {
    throw new Error('An action grant must record who confirmed it, an unattributed grant is not a confirmation.');
  }
  if (!input.description || input.description.trim().length === 0) {
    throw new Error('An action grant must carry a description of what it does, so the confirmation is informed.');
  }
  const now = input.now ?? Date.now();
  const base = { command, args: Object.freeze([...args]), ...(input.cwd !== undefined ? { cwd: input.cwd } : {}) };
  // Reconfirming only description/attribution must not invalidate existing
  // pinned triggers. A changed action receives a new revision. Earlier saved
  // grants retain their original pin rather than silently re-pinning history.
  const retained = previous?.id === input.id && sameAction(base, previous)
    && verifyRegisteredGrant([previous], previous.id, previous.digest).ok ? previous : undefined;
  const approvedAction = retained ? retained.approvedAction : Object.freeze({ version: 1 as const,
    command, args: base.args, cwd: input.cwd ?? null });
  return {
    id: input.id,
    description: input.description,
    ...base,
    createdAt: now,
    confirmedAt: now,
    confirmedBy: input.confirmedBy,
    digest: retained?.digest ?? `grant-revision-v1:${randomUUID().replace(/-/g, '')
      .replace(/[0-9a-f]/g, nibble => String.fromCharCode(97 + Number.parseInt(nibble, 16)))}`,
    ...(approvedAction === undefined ? {} : { approvedAction }),
  };
}

export type GrantVerification =
  | { readonly ok: true; readonly grant: TriggerActionGrant }
  | { readonly ok: false; readonly reason: string };

/**
 * Verifies a pinned grant at fire time. Three ways to fail, all refusals:
 * the grant is gone, its stored approval no longer matches its own contents
 * (edited on disk), or the trigger's pin does not match the grant.
 */
function verifyRegisteredGrant(
  grants: readonly TriggerActionGrant[],
  grantId: string,
  pinnedDigest: string,
): GrantVerification {
  const grant = grants.find((entry) => entry?.id === grantId);
  if (!grant) {
    return { ok: false, reason: `action grant "${grantId}" is not registered, refusing to fire` };
  }
  let matches = false;
  try {
    validateArgv(grant.command, grant.args, 'grant');
    if (grant.cwd !== undefined && typeof grant.cwd !== 'string') throw new Error('Invalid grant directory');
    const approval = grant.approvedAction;
    if (approval !== undefined) {
      matches = GRANT_REVISION.test(grant.digest) && validApproval(approval) && sameAction(grant, approval);
    } else if (/^[0-9a-f]{64}$/.test(grant.digest)) {
      // Only an actually registered earlier record reaches this compatibility
      // check. Fresh revision-shaped records cannot fall back to a checksum.
      matches = computeGrantDigest(grant) === grant.digest;
    }
  } catch { /* Malformed saved approval is a refusal, never an executable grant. */ }
  if (!matches) {
    return {
      ok: false,
      reason: `action grant "${grantId}" was modified after it was confirmed (stored approval does not match its contents), refusing to fire`,
    };
  }
  if (grant.digest !== pinnedDigest) {
    return {
      ok: false,
      reason: `action grant "${grantId}" no longer matches the digest this trigger was created against, re-confirm the grant to re-pin it`,
    };
  }
  return { ok: true, grant };
}

/** Native creation captures an independent pin from the actual registered
 * approval. A caller-provided approvedAction is deliberately overwritten. */
export function captureRegisteredGrantAction(grants: readonly TriggerActionGrant[], action: ActionGrantAction): ActionGrantAction {
  const verified = verifyRegisteredGrant(grants, action.grantId, action.digest);
  if (!verified.ok) throw new Error(`Cannot create this trigger: ${verified.reason}`);
  return Object.freeze({ kind: 'action-grant', grantId: action.grantId, digest: action.digest,
    ...(verified.grant.approvedAction === undefined ? {} : { approvedAction: captureApproval(verified.grant) }) });
}

/** Fire uses the independently retained trigger pin, never the grant's own
 * local copy as authority for changed bytes. Actual older SHA pins retain their
 * original content binding without synthesizing a new approved snapshot. */
export function verifyGrant(grants: readonly TriggerActionGrant[], grantId: string, pinnedDigest: string,
  approvedAction?: TriggerApprovedAction): GrantVerification {
  const verified = verifyRegisteredGrant(grants, grantId, pinnedDigest);
  if (!verified.ok) return verified;
  if (verified.grant.approvedAction !== undefined && (!approvedAction || !validApproval(approvedAction)
    || !sameAction(verified.grant, approvedAction))) return { ok: false,
      reason: `action grant "${grantId}" differs from the action approved for this trigger, re-confirm the trigger before firing` };
  // The executor may await after admission. Retain the checked argv rather
  // than lend it the registry's mutable array restored from disk.
  return { ok: true, grant: Object.freeze({ ...verified.grant, args: Object.freeze([...verified.grant.args]),
    ...(verified.grant.approvedAction === undefined ? {} : { approvedAction: captureApproval(verified.grant) }) }) };
}

import type { PermissionAttribution, PermissionPromptRequest, RememberTier } from '@goodvibes/engine/platform/platform/permissions';
import { decodeBase64, resolveEditText, type EditTextFields } from '@goodvibes/engine/platform/platform/control-plane/approval-hunk-apply';
import {
  applyHunkKey,
  buildHunkSelectionState,
  hunkSelectionAnswer,
  isHunkSelectable,
  type HunkCommit,
  type HunkKeyResult,
  type HunkSelectionAnswer,
  type HunkSelectionState,
} from '@goodvibes/engine/terminal-shell/hunk-selection';

/**
 * Per-hunk accept/reject at the approval card. The selection state and its
 * keys are shared with the Agent (terminal-shell hunk-selection.ts); which
 * entries are hunks and what each writes is the platform's one rule
 * (control-plane approval-hunk-apply.ts). The `write` (whole-file overwrite)
 * tool stays whole-payload accept/reject.
 */
export { applyHunkKey, buildHunkSelectionState, hunkSelectionAnswer, isHunkSelectable };
export type { HunkCommit, HunkKeyResult, HunkSelectionAnswer, HunkSelectionState };

/** Structural shape of one edit entry as a card reads it. */
export type EditItemLike = EditTextFields & { readonly path: string; readonly id?: string | undefined };

/**
 * The find and replace text the edit tool will use for one entry, for display.
 * An entry the edit tool would refuse (plain and base64 text that disagree)
 * still shows its base64 text, which is what the tool reads first.
 */
export function editItemText(item: EditTextFields & { readonly path?: string }): { readonly find: string; readonly replace: string } {
  const text = resolveEditText(item);
  if (!('error' in text)) return text;
  return {
    find: item.find_base64 ? decodeBase64(item.find_base64) : (item.find ?? ''),
    replace: item.replace_base64 !== undefined ? decodeBase64(item.replace_base64) : (item.replace ?? ''),
  };
}

/**
 * The decision a card resolves with. `selectedHunks` reaches the approval
 * broker, which applies it; `modifiedArgs` carries the same selection for a
 * resolver that forwards arguments only.
 */
export interface PermissionPromptDecisionWithModifiedArgs {
  approved: boolean;
  remember?: boolean;
  modifiedArgs?: Record<string, unknown>;
  selectedHunks?: readonly number[];
  /** Generalizing remember tier: 'session' | 'exact' | 'command-class' | 'path' | 'tool'. */
  rememberTier?: RememberTier;
  /** Free-text from the user; most useful on deny, rides the structured "user declined" tool result. */
  reason?: string;
}

/** Extra decision fields a resolve call can carry beyond approve/remember/modifiedArgs. */
export interface PermissionResolveExtras {
  readonly rememberTier?: RememberTier;
  readonly reason?: string;
  readonly selectedHunks?: readonly number[];
}

/** Narrow approval-broker surface needed to attribute a prompt to its requester. */
export interface ApprovalRequesterLookup {
  listApprovals(limit?: number): ReadonlyArray<{
    readonly callId: string;
    readonly sessionId?: string | undefined;
    readonly metadata: Record<string, unknown>;
  }>;
}

/**
 * Human label for a `mcp-server` or `sandbox-escalation` attribution, the two
 * non-agent origins the approval broker can name (see PermissionAttribution in
 * the platform). `background-agent` deliberately falls through to the
 * broker-metadata lookup below instead, which resolves a richer label
 * (agentId/session) than the attribution alone carries.
 */
function describeNonAgentAttribution(attribution: PermissionAttribution): string | null {
  switch (attribution.kind) {
    case 'mcp-server':
      return `MCP server: ${attribution.serverName}`;
    case 'sandbox-escalation':
      return `${attribution.sandbox} wants: ${attribution.escalations.join(', ')}`;
    default:
      return null;
  }
}

/**
 * Human label for WHICH agent/process/server/sandbox raised this approval.
 *
 * Prefers the request's own typed `attribution` (see PermissionAttribution)
 * for the `mcp-server` and `sandbox-escalation` origins, since those carry
 * structured data (which server, which escalations) no broker-metadata scan
 * can reconstruct. For `background-agent` (and when no attribution is
 * present), falls back to the approval broker by callId (the broker record
 * for a request exists by the time its local prompt is shown), preferring an
 * explicit requester recorded in the broker record's metadata (agentId /
 * agent / requestedBy / actor / actorSurface), then the owning session id.
 * Returns null when nothing identifying is available, the prompt then omits
 * the attribution line rather than guessing a name.
 */
export function resolveApprovalRequester(
  broker: ApprovalRequesterLookup | null | undefined,
  callId: string,
  attribution?: PermissionAttribution | undefined,
): string | null {
  if (attribution && attribution.kind !== 'background-agent') {
    const described = describeNonAgentAttribution(attribution);
    if (described) return described;
  }
  if (!broker) return null;
  let record: { readonly sessionId?: string | undefined; readonly metadata: Record<string, unknown> } | undefined;
  try {
    record = broker.listApprovals().find((r) => r.callId === callId);
  } catch {
    return null;
  }
  if (!record) return null;
  const meta = record.metadata ?? {};
  for (const key of ['agentId', 'agent', 'requestedBy', 'actor', 'actorSurface'] as const) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  if (typeof record.sessionId === 'string' && record.sessionId.length > 0) {
    return `session ${record.sessionId.slice(0, 8)}`;
  }
  return null;
}

/**
 * buildPendingPermissionExtras, the `hunkState` + wrapped `resolve` fields
 * (plus the input-debounce timestamp and requester attribution) main.ts spreads
 * onto its PendingPermissionState alongside `...request`. Bundled into one
 * helper (rather than inlined in main.ts) to keep main.ts's net line count at
 * zero for this change, main.ts sits at the 800-line architecture cap and must
 * never grow it.
 *
 * `openedAt` is the moment the prompt appeared; the blocking-input handler
 * (routeCardInput) passes keys typed within the settle time after it, or as
 * one burst, to the composer, so typed-ahead text cannot answer a prompt the
 * user has not seen yet and is not lost. `requestedBy` is the
 * requester attribution resolved from the broker (see resolveApprovalRequester).
 */
export function buildPendingPermissionExtras(
  request: PermissionPromptRequest,
  resolvePromise: (decision: PermissionPromptDecisionWithModifiedArgs) => void,
  broker?: ApprovalRequesterLookup | null,
  now: number = Date.now(),
): {
  hunkState: HunkSelectionState | undefined;
  resolve: (approved: boolean, remember?: boolean, modifiedArgs?: Record<string, unknown>, extras?: PermissionResolveExtras) => void;
  openedAt: number;
  requestedBy: string | undefined;
  replyMode: 'exec-answer' | undefined;
  replyBuffer: string | undefined;
} {
  // An exec-prompt ask (a running command waiting on stdin) opens straight in
  // answer mode: every printable key types the answer, a run whose prompt
  // needs a literal 'y' must never have it eaten as a card command key.
  const isExecPrompt = request.attribution?.kind === 'exec-prompt';
  return {
    hunkState: isHunkSelectable(request) ? buildHunkSelectionState(request) : undefined,
    resolve: (approved, remember = false, modifiedArgs, extras) => resolvePromise({
      approved,
      remember,
      modifiedArgs,
      ...(extras?.rememberTier ? { rememberTier: extras.rememberTier } : {}),
      ...(extras?.reason ? { reason: extras.reason } : {}),
      ...(approved && extras?.selectedHunks ? { selectedHunks: extras.selectedHunks } : {}),
    }),
    openedAt: now,
    requestedBy: resolveApprovalRequester(broker, request.callId, request.attribution) ?? undefined,
    replyMode: isExecPrompt ? 'exec-answer' : undefined,
    replyBuffer: isExecPrompt ? '' : undefined,
  };
}

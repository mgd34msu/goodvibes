/**
 * shared-kind-gifts.ts, the daemon's side of the owner's shared things (control-plane/shared-kinds.ts): whether a call
 * of a caller that is not the owner may reach the shared kind it acts on, and the one question put to the owner the
 * first time it tries one it was not given.
 *
 * Read where every call is admitted (the dispatch, daemon/control-plane.ts, and the REST router, daemon/http/router.ts),
 * after the folder and reach checks and before anything is put to the owner or run. The owner himself, his programs
 * and his own turns pass. Anyone else passes only with the gift of that kind; without it the owner is asked ONCE per
 * caller and kind ("Let the paired device "kiosk" read and send your mail?", opening on No, bounded with every other
 * question of that caller: control-plane/approval-broker.ts), answered at once with the question's id; on his yes the
 * kind is given (kept in `<daemon home>/caller-shared.json`) and the same call can be sent again; on his No it is not
 * asked again while the daemon runs. A turn on someone else's input is never asked about: it is refused (it cannot wait).
 */
import { randomUUID } from 'node:crypto';
import type { ApprovalBroker } from '../control-plane/approval-broker.js';
import { CallerSharedStore, SHARED_KIND_WORDS, knowledgeCallOfProject, setSharedKindGiftReader, sharedKindAsker, sharedKindOfCall, sharedKindRefusalWords, type SharedKind, type SharedKindCaller } from '../control-plane/shared-kinds.js';
import { reacherOf } from '../control-plane/caller-reach.js';
import { OWNER_QUESTIONS_FULL } from '../control-plane/owner-question-bounds.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/native-error-summary.js';

export type SharedKindAnswer = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly pendingApprovalId?: string };
export type SharedKindRule = (caller: SharedKindCaller, kind: SharedKind) => Promise<SharedKindAnswer>;

/** The rule of this daemon (set once where it is composed), read by every door: the dispatch and the REST router. */
let daemonRule: SharedKindRule | undefined;
export function setDaemonSharedKindRule(rule: SharedKindRule): void { daemonRule = rule; }
export function daemonSharedKindRule(): SharedKindRule | undefined { return daemonRule; }

/**
 * Whether a call of this caller may reach the shared kind it acts on (control-plane/shared-kinds.ts): the answer, the
 * refusal, or the one question to the owner. Without a rule, only the owner's own reach one (never "no rule, no check").
 * The daemon's own in-process calls (the system actor) are its own.
 */
export async function sharedKindAdmission(rule: SharedKindRule | undefined, methodId: string, body: unknown,
  context: (NonNullable<Parameters<typeof reacherOf>[0]> & { readonly daemonTurn?: boolean | undefined }) | undefined): Promise<SharedKindAnswer> {
  const kind = sharedKindOfCall(methodId, body);
  if (kind === undefined) return { ok: true };
  // A project's knowledge is reached like any other record of its project, with no gift: a read the knowledge reach
  // filters (the owner's shared knowledge left out unless given), or an addition into the project the call names
  // (shared-kinds.ts `knowledgeCallOfProject`). Never stopped here before that filter runs.
  if (kind === 'knowledge' && knowledgeCallOfProject(methodId, body, namesProject(body, context))) return { ok: true };
  const caller: SharedKindCaller = {
    ownersOwn: reacherOf(context, body).everything || context?.actor?.class === 'system',
    daemonTurn: context?.daemonTurn === true || context?.clientKind === 'daemon-turn' || context?.call?.daemonTurn === true,
    othersInput: context?.call?.othersInput === true,
    ...(context?.call?.othersInputFor ? { othersInputFor: context.call.othersInputFor } : {}),
    ...(context?.principalId ? { principalId: context.principalId } : {}),
  };
  if (rule) return rule(caller, kind);
  return sharedKindAsker(caller) === undefined ? { ok: true } : { ok: false, reason: sharedKindRefusalWords(kind, false) };
}

/** Whether a call names a project: its body's `workingDirectory` or its call context's project (the folder check holds it). */
function namesProject(body: unknown, context: { readonly call?: { readonly project?: string | undefined } | undefined } | undefined): boolean {
  const folder = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)['workingDirectory'] : undefined;
  return (typeof folder === 'string' && folder.trim() !== '') || (typeof context?.call?.project === 'string' && context.call.project.trim() !== '');
}

/** The caller, in the owner's words, for the question. */
function callerWords(principalId: string, deviceName: ((pairingId: string) => string | undefined) | undefined): string {
  if (principalId.startsWith('pairing:')) {
    const id = principalId.slice('pairing:'.length);
    const name = deviceName?.(id);
    return name ? `the paired device "${name}"` : `the paired device ${id}`;
  }
  if (principalId === 'local') return 'a program on this computer using your operator token';
  if (principalId === 'shared-token') return 'a program using your operator token from another machine';
  return `the member "${principalId}"`;
}

export function createSharedKindGifts(deps: {
  readonly homeDirectory: string;
  readonly broker: Pick<ApprovalBroker, 'raiseApproval'>;
  readonly deviceName?: ((pairingId: string) => string | undefined) | undefined;
}): SharedKindRule {
  const store = new CallerSharedStore(resolveGoodVibesDaemonHome(deps.homeDirectory));
  // The filters that keep the owner's shared records out of what a caller is given read the same gifts.
  setSharedKindGiftReader((principalId, kind) => store.has(principalId, kind));
  /** One open question per caller and kind: its approval's id. */
  const open = new Map<string, string>();
  /** Callers and kinds the owner said No to while this daemon runs. */
  const refused = new Set<string>();

  const ask = async (principalId: string, kind: SharedKind): Promise<string> => {
    const key = `${principalId}\u0000${kind}`;
    const waiting = open.get(key);
    if (waiting) return waiting;
    const who = callerWords(principalId, deps.deviceName);
    const question = `Let ${who} ${SHARED_KIND_WORDS[kind]}?`;
    const raised = await deps.broker.raiseApproval({
      request: {
        callId: `shared-kind-${randomUUID()}`, tool: 'shared-kind.give', args: { who: principalId, kind }, category: 'write',
        analysis: { classification: 'owner-act', riskLevel: 'high', summary: question,
          reasons: [`${who[0]!.toUpperCase()}${who.slice(1)} asked for something of yours that belongs to no project (your ${kind}). On yes it may ${SHARED_KIND_WORDS[kind]} until you take it back in Devices and network, on its row; nothing else of yours is given, and every act you decide is still put to you.`] },
        ownerOnly: 'owner-act', rememberOptions: [],
      },
      // Who asks is recorded: the broker bounds that caller's questions and lists them as its own.
      metadata: { source: 'shared-kind', kind, requestedBy: principalId },
    });
    open.set(key, raised.approval.id);
    void raised.decision.then((decision) => {
      if (decision.approved !== true) { refused.add(key); return; }
      store.set(principalId, [...store.kindsOf(principalId), kind]);
    }, (error: unknown) => {
      logger.warn('[shared] the question for a shared kind ended without an answer; nothing is given', { kind, error: summarizeError(error) });
    }).finally(() => open.delete(key));
    return raised.approval.id;
  };

  return async (caller, kind) => {
    const asker = sharedKindAsker(caller);
    if (asker === undefined) return { ok: true };
    const principalId = asker.principalId;
    if (principalId !== undefined && store.has(principalId, kind)) return { ok: true };
    // A turn on someone else's input, or a caller the daemon could not name: refused, never asked (it cannot wait).
    if (principalId === undefined || caller.daemonTurn) return { ok: false, reason: sharedKindRefusalWords(kind, false) };
    if (refused.has(`${principalId}\u0000${kind}`)) return { ok: false, reason: `${sharedKindRefusalWords(kind, false)}; the owner said no to it` };
    try {
      const approvalId = await ask(principalId, kind);
      return { ok: false, pendingApprovalId: approvalId,
        reason: `${sharedKindRefusalWords(kind, true)}; the owner has been asked once in Waiting for you (approval ${approvalId}) whether it may; nothing ran. Send the same call again once he has answered` };
    } catch (error) {
      if ((error as { readonly code?: unknown }).code === OWNER_QUESTIONS_FULL) return { ok: false, reason: (error as Error).message };
      throw error;
    }
  };
}

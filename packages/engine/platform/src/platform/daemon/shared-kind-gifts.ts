/**
 * shared-kind-gifts.ts, the daemon's side of the owner's shared things (control-plane/shared-kinds.ts): whether a call
 * of a caller that is not the owner may reach the shared kind it acts on, and the decision the first time it tries one
 * it was not given.
 *
 * Read where every call is admitted (the dispatch, daemon/control-plane.ts, and the REST router, daemon/http/router.ts),
 * after the folder and reach checks and before anything runs. The owner in person, their programs and their own turns pass.
 * Anyone else passes with the gift of that kind; without it, giving it is decided by the daemon's one permission
 * manager under the owner's mode, as a loosening with who asks as a fact (capability-owner-gate.ts `decideGrant`):
 * YOLO gives it, Jev decides and Just vibes ask Jev, Ask me asks the owner while the call waits. Given, the kind is kept (in
 * `<daemon home>/caller-shared.json`) and the call goes on. A turn on someone else's input is refused.
 */
import { CallerSharedStore, SHARED_KIND_WORDS, knowledgeCallOfProject, setSharedKindGiftReader, sharedKindAsker, sharedKindOfCall, sharedKindOfMethod, sharedKindRefusalWords, type SharedKind, type SharedKindCaller } from '../control-plane/shared-kinds.js';
import { reacherOf } from '../control-plane/caller-reach.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';
import { logger } from '../utils/logger.js';
import { decideGrant } from './capability-owner-gate.js';

export type SharedKindAnswer = { readonly ok: true } | { readonly ok: false; readonly reason: string };
/** `signal`: the asking request's; its connection closing withdraws a question Ask me raised for it. */
export type SharedKindRule = (caller: SharedKindCaller, kind: SharedKind, signal?: AbortSignal) => Promise<SharedKindAnswer>;

/** The rule of this daemon (set once where it is composed), read by every door: the dispatch and the REST router. */
let daemonRule: SharedKindRule | undefined;
export function setDaemonSharedKindRule(rule: SharedKindRule): void { daemonRule = rule; }
export function daemonSharedKindRule(): SharedKindRule | undefined { return daemonRule; }

/**
 * Whether a call of this caller may reach the shared kind it acts on (control-plane/shared-kinds.ts): the answer, the
 * refusal, decided under the owner's mode. Without a rule, only the owner's own reach one (never "no rule, no check").
 * The daemon's own in-process calls (the system actor) are its own.
 */
export async function sharedKindAdmission(rule: SharedKindRule | undefined, methodId: string, body: unknown,
  context: (NonNullable<Parameters<typeof reacherOf>[0]> & { readonly daemonTurn?: boolean | undefined }) | undefined, signal?: AbortSignal): Promise<SharedKindAnswer> {
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
  if (rule) return rule(caller, kind, signal);
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

/** A credential that exists when the daemon starts, with what its scopes are (`all`: full authority). */
export interface ExistingCredential {
  readonly principalId: string;
  readonly scopes: readonly string[] | 'all';
}

/**
 * The shared kinds a credential's scopes let it use: every kind for full authority; otherwise each kind one of whose
 * methods needs a scope it holds (`kindScopes`: the scopes the methods of each kind need, read from the method catalog).
 */
export function sharedKindsOfScopes(scopes: readonly string[] | 'all', kindScopes: ReadonlyMap<SharedKind, ReadonlySet<string>>): SharedKind[] {
  if (scopes === 'all' || scopes.includes('*')) return [...kindScopes.keys()];
  return [...kindScopes].filter(([, needed]) => scopes.some((scope) => needed.has(scope))).map(([kind]) => kind);
}

/** The scopes each shared kind's methods need, from the method catalog's descriptors (shared-kinds.ts `sharedKindOfMethod`). */
export function sharedKindScopes(methods: readonly { readonly id: string; readonly scopes: readonly string[] }[]): Map<SharedKind, Set<string>> {
  const byKind = new Map<SharedKind, Set<string>>();
  for (const method of methods) {
    const kind = sharedKindOfMethod(method.id);
    if (kind === undefined) continue;
    const scopes = byKind.get(kind) ?? new Set<string>();
    for (const scope of method.scopes) scopes.add(scope);
    byKind.set(kind, scopes);
  }
  return byKind;
}

export function createSharedKindGifts(deps: {
  readonly homeDirectory: string;
  readonly deviceName?: ((pairingId: string) => string | undefined) | undefined;
  /**
   * The upgrade from 3.5.0, once per daemon home (CallerSharedStore `carryFrom350`): the credentials that exist at this
   * daemon's first start of this version (its paired devices and its members, never the owner), and the scopes each
   * shared kind's methods need. Each is given the kinds its released scopes let it use, recorded as carried from 3.5.0.
   */
  readonly carryFrom350?: (() => { readonly existing: readonly ExistingCredential[]; readonly kindScopes: ReadonlyMap<SharedKind, ReadonlySet<string>> }) | undefined;
}): SharedKindRule {
  const store = new CallerSharedStore(resolveGoodVibesDaemonHome(deps.homeDirectory));
  if (deps.carryFrom350) {
    try {
      const { existing, kindScopes } = deps.carryFrom350();
      const carried = store.carryFrom350(existing.map((credential) => ({ principalId: credential.principalId, kinds: sharedKindsOfScopes(credential.scopes, kindScopes) })));
      const count = Object.keys(carried).length;
      if (count > 0) logger.info('[shared] kinds carried from 3.5.0 to the credentials that existed', { callers: count });
    } catch (error) {
      // Not carried now: the next start tries again (nothing was marked done).
      logger.warn('[shared] the carry from 3.5.0 could not run', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  // The filters that keep the owner's shared records out of what a caller is given read the same gifts.
  setSharedKindGiftReader((principalId, kind) => store.has(principalId, kind));
  const give = (principalId: string, kind: SharedKind): void => {
    if (!store.has(principalId, kind)) store.set(principalId, [...store.kindsOf(principalId), kind]);
  };

  return async (caller, kind, signal) => {
    const asker = sharedKindAsker(caller);
    if (asker === undefined) return { ok: true };
    const principalId = asker.principalId;
    if (principalId !== undefined && store.has(principalId, kind)) return { ok: true };
    // A turn on someone else's input, or a caller the daemon could not name: refused (their words never reach the owner's things).
    if (principalId === undefined || caller.daemonTurn) return { ok: false, reason: sharedKindRefusalWords(kind, false) };
    // The first use of this kind by this caller: decided by the daemon's one permission manager under the owner's mode,
    // a loosening with who asks as a fact (capability-owner-gate.ts `decideGrant`). Given, it is kept for that caller.
    const who = callerWords(principalId, deps.deviceName);
    const decided = await decideGrant({
      id: `shared-kind.${kind}`, label: `Let ${who} ${SHARED_KIND_WORDS[kind]}`,
      sentence: `${who[0]!.toUpperCase()}${who.slice(1)} asked for something of yours that belongs to no project (your ${kind}). It may then ${SHARED_KIND_WORDS[kind]} until you take it back in Devices and network, on its row; nothing else of yours is given.`,
      runsAs: { principalId, ...(principalId.startsWith('pairing:') ? { credentialKind: 'device-token' as const } : principalId === 'local' ? { credentialKind: 'local' as const } : {}) },
      ...(signal ? { signal } : {}),
    });
    if (!decided.approved) {
      logger.info('[shared] a shared kind was not given', { kind, reason: decided.reason });
      return { ok: false, reason: `${sharedKindRefusalWords(kind, false)}: ${decided.reason ?? 'it was not allowed under the owner\'s permission mode'}` };
    }
    give(principalId, kind);
    return { ok: true };
  };
}

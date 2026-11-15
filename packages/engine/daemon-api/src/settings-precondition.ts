import { createSingleUseReferenceTable } from './single-use-reference-table.js';

/**
 * A bounded same-serving-owner precondition for the adopted SETTINGS HTTP lane.
 * This is neither a Jev grant nor persisted-file CAS. Existing persistence stays
 * last-writer-wins. The caller still needs its authentic manager/registry act.
 */
export interface SettingsPreconditionRequest {
  readonly operation: 'set' | 'reset-default';
  readonly key: string;
  readonly value?: unknown;
  /** Remove only this setting's derived credential in its owning scope. */
  readonly credentialClear?: true;
}
export interface SettingsPreconditionFacts extends SettingsPreconditionRequest {
  readonly value: unknown;
  readonly destinations: readonly { readonly path: string; readonly operation: 'set' | 'remove'; readonly tier: string }[];
  readonly incarnation: number;
  readonly credential?: {
    readonly key: string;
    readonly scope: 'daemon' | 'user';
    readonly destinations: readonly { readonly path: string; readonly operation: 'remove'; readonly tier: string }[];
  };
}
export interface SettingsPreconditionReceipt {
  readonly status: 'committed' | 'partial' | 'unknown';
  readonly completedPaths: readonly string[];
  readonly uncertainPath?: string;
  /** Reporting only, required on committed wire receipts. Failure never undoes publication. */
  readonly verifiedInOwningStore?: boolean;
  /**
   * Client-side only, never on the wire: set on an `unknown` receipt when the
   * owner answered with a precondition refusal, which every handler returns
   * before any effect. Nothing was applied; a fresh capture may try again.
   */
  readonly refused?: true;
  /** Client-side only: why the owner refused (see {@link SettingsRefusalReason}); present only with `refused`. */
  readonly refusalReason?: SettingsRefusalReason;
}
/**
 * Value-free reason on a refusal that happened before any effect, so a caller can
 * choose its next step without parsing text:
 * - `stale`: the capture is out of date (setting, owner or serving lifetime changed, or it expired); recapture.
 * - `spent`: this reference was already used; capture again, do not resend it.
 * - `managed`: managed policy locks the setting; stop, only the policy owner can change it.
 * - `read-only`: the settings owner is read-only here; stop, or use a writable owner.
 * - `owner-fault`: an owner store (pairing store, configuration lock) is faulted or busy; see the message; retry only for a busy lock.
 */
export type SettingsRefusalReason = 'stale' | 'spent' | 'managed' | 'read-only' | 'owner-fault';
export const SETTINGS_REFUSAL_REASONS: readonly SettingsRefusalReason[] = ['stale', 'spent', 'managed', 'read-only', 'owner-fault'];
/** The reason an owner error carries (`refusalReason`), or `owner-fault` for a faulted pairing store. */
export function settingsRefusalReason(error: unknown): SettingsRefusalReason | undefined {
  if (isPairingStoreFault(error)) return 'owner-fault';
  const reason = error instanceof Error ? (error as Error & { readonly refusalReason?: unknown }).refusalReason : undefined;
  return SETTINGS_REFUSAL_REASONS.find(known => known === reason);
}
export interface SettingsPreconditionHandler {
  /** Capture before the body await so stop/rebind/token ABA cannot cross it. */
  lifetime(): object | null;
  handle(req: Request, payload: Record<string, unknown>, requestLifetime: object | null): Response | Promise<Response>;
}
interface Options<Prepared, Transition, Authority> {
  readonly owner: {
    prepare(request: SettingsPreconditionRequest): Prepared;
    inspect(prepared: Prepared): SettingsPreconditionFacts;
    assert(prepared: Prepared): void;
    begin(prepared: Prepared): Transition;
    assertTransition(prepared: Prepared, transition: Transition): void;
    finish(prepared: Prepared, transition: Transition, assertCurrent: () => void): SettingsPreconditionReceipt;
    /** Acquire physical ownership before entering the synchronous auth/effect tail. */
    withPrepared?<T>(prepared: Prepared, operation: () => T): Promise<T>;
  };
  readonly lifetime: () => object | null;
  readonly captureAuthority: (req: Request) => Authority | null;
  readonly withAuthority: <T>(req: Request, authority: Authority, callback: (assertCurrent: () => void) => T) => T;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every(key => fields.includes(key));
}
/** The daemon's pairing store is faulted: a retry of the same request will not help until it recovers. */
export function isPairingStoreFault(error: unknown): boolean {
  return error instanceof Error && (error as Error & { readonly code?: unknown }).code === 'PAIRING_STORE_FAULTED';
}

function refusal(status: number, code: string, reason?: SettingsRefusalReason): Response {
  // Never echo body, normalized values, credentials, paths or owner errors.
  return Response.json({ error: 'Settings owner precondition unavailable', code, ...(reason ? { reason } : {}) }, { status });
}
export function createSettingsPreconditionHandler<Prepared, Transition, Authority>(
  options: Options<Prepared, Transition, Authority>,
): SettingsPreconditionHandler {
  const references = createSingleUseReferenceTable<{ prepared: Prepared; authority: Authority; lifetime: object; expiresAt: number }>();
  const synchronize = (): object | null => {
    const current = options.lifetime();
    references.synchronize(current);
    return current;
  };
  return {
    lifetime: options.lifetime,
    handle(req, payload, requestLifetime) {
      const arm = payload.settingsPrecondition;
      if (!exact(payload, ['settingsPrecondition']) || !record(arm) || arm.version !== 1) {
        return refusal(400, 'SETTINGS_PRECONDITION_INVALID');
      }
      if (arm.action === 'capture') {
        const fields = arm.operation === 'set' ? ['version', 'action', 'operation', 'key', 'value'] : ['version', 'action', 'operation', 'key'];
        if (Object.hasOwn(arm, 'credentialClear')) fields.push('credentialClear');
        if (!exact(arm, fields) || (Object.hasOwn(arm, 'credentialClear') && arm.credentialClear !== true) || (arm.operation !== 'set' && arm.operation !== 'reset-default')
          || typeof arm.key !== 'string' || !arm.key || arm.key === 'runtime.workingDir') return refusal(400, 'SETTINGS_PRECONDITION_INVALID');
        const lifetime = synchronize();
        if (lifetime === null || lifetime !== requestLifetime) return refusal(409, 'SETTINGS_PRECONDITION_STALE', 'stale');
        try {
          const prepared = options.owner.prepare({ operation: arm.operation, key: arm.key, ...(arm.operation === 'set' ? { value: arm.value } : {}), ...(arm.credentialClear === true ? { credentialClear: true } : {}) });
          const facts = options.owner.inspect(prepared);
          options.owner.assert(prepared);
          // Preparation is read-only but may validate. Capture current authority
          // after it, rather than accepting authority observed before callbacks.
          const authority = options.captureAuthority(req);
          if (authority === null || options.lifetime() !== lifetime) return refusal(409, 'SETTINGS_PRECONDITION_STALE', 'stale');
          const { reference, expiresAt } = references.issue({ prepared, authority, lifetime });
          return Response.json({ settingsPrecondition: { version: 1, action: 'captured', reference, expiresAt, facts } });
        } catch (error) { return refusal(409, isPairingStoreFault(error) ? 'PAIRING_STORE_FAULTED' : 'SETTINGS_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error)); }
      }
      if (arm.action !== 'apply' || !exact(arm, ['version', 'action', 'reference'])
        || typeof arm.reference !== 'string' || !arm.reference || arm.reference.length > 128) return refusal(400, 'SETTINGS_PRECONDITION_INVALID');
      const lifetime = synchronize();
      // One use, including auth/currentness refusal. No same-reference retry.
      const { entry, spent: wasSpent } = references.take(arm.reference);
      if (!entry || lifetime === null || lifetime !== requestLifetime || entry.lifetime !== lifetime || entry.expiresAt <= Date.now()) {
        return refusal(409, 'SETTINGS_PRECONDITION_STALE', wasSpent ? 'spent' : 'stale');
      }
      const apply = (): Response => { try {
        const receipt = options.withAuthority(req, entry.authority, (assertCurrent) => {
          const assertBound = () => { assertCurrent(); if (options.lifetime() !== entry.lifetime || Date.now() >= entry.expiresAt) throw new Error('stale'); };
          assertBound();
          options.owner.assert(entry.prepared);
          const transition = options.owner.begin(entry.prepared);
          // begin performs all validators/invalidation subscribers. Final auth,
          // exact owner transition and lifetime checks precede callback-free I/O.
          assertBound();
          options.owner.assertTransition(entry.prepared, transition);
          if (options.lifetime() !== entry.lifetime || Date.now() >= entry.expiresAt) throw new Error('stale');
          return options.owner.finish(entry.prepared, transition, assertBound);
        });
        // No post-effect auth assertion can turn a completed mutation into a
        // refusal. Only the physical owner's truthful receipt is acknowledged.
        return Response.json({ settingsPrecondition: { version: 1, action: 'applied', reference: arm.reference, receipt } });
      } catch (error) { return refusal(409, 'SETTINGS_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error)); } };
      return options.owner.withPrepared
        ? options.owner.withPrepared(entry.prepared, apply).catch((error: unknown) => refusal(409, 'SETTINGS_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error)))
        : apply();
    },
  };
}

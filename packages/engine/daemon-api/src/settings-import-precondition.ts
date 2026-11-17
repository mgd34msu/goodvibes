import type { SettingsPreconditionReceipt } from './settings-precondition.js';
import { createRequestReceiptTable, createSingleUseReferenceTable, requestFingerprint, servingIdOf } from './single-use-reference-table.js';
import { isPairingStoreFault, settingsRefusalReason, type SettingsRefusalReason } from './settings-precondition.js';

/**
 * A settings import is the single-setting write over a list: one `write`
 * carries the settings, the revision the caller saw (`ifIncarnation` with
 * `ifServing`, the serving period it was read in) and an optional `requestId`
 * that makes a repeat answer the first result. `capture`
 * answers the facts first for a caller that shows them before deciding;
 * `capture` with `apply` by reference remains for clients that still send it.
 *
 * Private authenticated ingress. Values never form hosted judgment evidence.
 */
export interface SettingsImportPreconditionRequest {
  readonly settings: readonly { readonly key: string; readonly value: unknown }[];
}
type Destination = { readonly path: string; readonly operation: 'set' | 'remove'; readonly tier: string };
export interface SettingsImportPreconditionFacts {
  readonly operation: 'import';
  readonly effects: readonly { readonly operation: 'set'; readonly key: string; readonly value: unknown; readonly destinations: readonly Destination[] }[];
  readonly incarnation: number;
  readonly destinations: readonly Destination[];
  readonly credential?: {
    readonly items: readonly { readonly key: string; readonly scope: 'daemon' | 'user'; readonly configured: boolean }[];
    readonly destinations: readonly Destination[];
  };
}
export type SettingsImportPreconditionReceipt = SettingsPreconditionReceipt;
export interface SettingsImportPreconditionHandler {
  lifetime(): object | null;
  handle(req: Request, payload: Record<string, unknown>, requestLifetime: object | null): Promise<Response>;
}
interface Options<Prepared, Transition, Authority> {
  readonly owner: {
    prepare(request: SettingsImportPreconditionRequest): Prepared;
    inspect(prepared: Prepared): SettingsImportPreconditionFacts;
    assert(prepared: Prepared): void;
    begin(prepared: Prepared): Transition;
    assertTransition(prepared: Prepared, transition: Transition): void;
    finish(prepared: Prepared, transition: Transition, assertCurrent: () => void): SettingsImportPreconditionReceipt;
    withPrepared<T>(prepared: Prepared, operation: () => T, assertCurrent: () => void): Promise<T>;
  };
  readonly lifetime: () => object | null;
  readonly captureAuthority: (req: Request) => Authority | null;
  readonly withAuthority: <T>(req: Request, authority: Authority, callback: (assertCurrent: () => void) => T) => T;
  /** Server-owned admission over prepared value-safe facts, before the publication lease. */
  readonly admit: <T>(req: Request, authority: Authority, prepared: Prepared, assertCurrent: () => void,
    apply: (claim: () => void, assertAdmissionCurrent: () => void) => Promise<T>) => Promise<T>;
  /** The credential the request was sent with; a `requestId` is remembered per caller. */
  readonly caller?: (req: Request) => string;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every(key => fields.includes(key));
}
interface Answer { readonly status: number; readonly body: Record<string, unknown> }
function refusal(status: number, code: string, reason?: SettingsRefusalReason, extra: Record<string, unknown> = {}): Answer {
  return { status, body: { error: 'Settings import owner unavailable', code, ...(reason ? { reason } : {}), ...extra } };
}
function respond(result: Answer): Response { return Response.json(result.body, { status: result.status }); }
/** The settings list of a `capture` or `write` arm, or undefined when it is malformed. */
function readSettings(value: unknown): SettingsImportPreconditionRequest['settings'] | undefined {
  if (!Array.isArray(value) || !value.length
    || !value.every(entry => record(entry) && exact(entry, ['key', 'value']) && typeof entry.key === 'string' && entry.key.length > 0)) return undefined;
  // Structural validation precedes this copy; private values stay in the native owner.
  return value.map(entry => ({ key: (entry as Record<string, unknown>).key as string, value: (entry as Record<string, unknown>).value }));
}

export function createSettingsImportPreconditionHandler<Prepared, Transition, Authority>(options: Options<Prepared, Transition, Authority>): SettingsImportPreconditionHandler {
  const references = createSingleUseReferenceTable<{ prepared: Prepared; authority: Authority; lifetime: object; expiresAt: number }>();
  // Only an import that happened is remembered; a refusal can be resent under the same id.
  const answered = createRequestReceiptTable<Answer>(result => result.status === 200);
  const synchronize = () => {
    const current = options.lifetime();
    references.synchronize(current);
    return current;
  };

  /**
   * The write itself, after the request was prepared and its authority taken.
   * `assertBound` is the request's own currentness (still wanted, same serving
   * owner); it is checked once after each await and once before the effect.
   */
  const apply = async (req: Request, prepared: Prepared, authority: Authority, assertBound: () => void): Promise<SettingsImportPreconditionReceipt> =>
    options.admit(req, authority, prepared, assertBound, (claim, assertAdmissionCurrent) =>
      options.owner.withPrepared(prepared, () => options.withAuthority(req, authority, assertAuthority => {
        const current = () => { assertAuthority(); assertBound(); assertAdmissionCurrent(); };
        // The owner lock was awaited: one owner and authority check, then the
        // claim and begin (whose validators run callbacks), then one more check
        // before the synchronous write.
        current(); options.owner.assert(prepared); claim();
        const transition = options.owner.begin(prepared);
        current(); options.owner.assertTransition(prepared, transition);
        return options.owner.finish(prepared, transition, current);
      }), assertAdmissionCurrent));

  const write = async (req: Request, settings: SettingsImportPreconditionRequest['settings'], expected: { readonly incarnation?: number; readonly serving?: string },
    requestId: string | undefined, requestLifetime: object | null): Promise<Answer> => {
    const lifetime = options.lifetime();
    if (lifetime === null || lifetime !== requestLifetime) return refusal(409, 'SETTINGS_IMPORT_PRECONDITION_STALE', 'stale');
    const serving = servingIdOf(lifetime);
    let prepared: Prepared; let facts: SettingsImportPreconditionFacts; let authority: Authority | null;
    try {
      prepared = options.owner.prepare({ settings });
      facts = options.owner.inspect(prepared);
      if ((expected.serving !== undefined && expected.serving !== serving)
        || (expected.incarnation !== undefined && facts.incarnation !== expected.incarnation)) {
        return refusal(409, 'SETTINGS_IMPORT_PRECONDITION_STALE', 'stale', {
          state: 'nothing was imported; the settings moved since the caller read them',
          next: ['Read the settings again and resend the import with the new ifIncarnation and ifServing'],
          currentIncarnation: facts.incarnation, serving,
        });
      }
      authority = options.captureAuthority(req);
    } catch (error) { return refusal(409, isPairingStoreFault(error) ? 'PAIRING_STORE_FAULTED' : 'SETTINGS_IMPORT_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error)); }
    if (authority === null || req.signal.aborted) return refusal(409, 'SETTINGS_IMPORT_PRECONDITION_STALE', 'stale');
    const assertBound = () => {
      req.signal.throwIfAborted();
      if (options.lifetime() !== lifetime) throw new Error('Settings import retired');
    };
    try {
      const receipt = await apply(req, prepared, authority, assertBound);
      return { status: 200, body: { settingsImportPrecondition: { version: 1, action: 'written', ...(requestId ? { requestId } : {}), facts, serving, receipt } } };
    } catch (error) { return refusal(409, 'SETTINGS_IMPORT_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error)); }
  };

  return { lifetime: options.lifetime, async handle(req, payload, requestLifetime) {
    const arm = payload.settingsImportPrecondition;
    if (!exact(payload, ['settingsImportPrecondition']) || !record(arm) || arm.version !== 1) return respond(refusal(400, 'SETTINGS_IMPORT_PRECONDITION_INVALID'));
    if (arm.action === 'write') {
      const fields = ['version', 'action', 'settings', ...['ifIncarnation', 'ifServing', 'requestId'].filter(field => Object.hasOwn(arm, field))];
      const settings = exact(arm, fields) ? readSettings(arm.settings) : undefined;
      const { ifIncarnation, ifServing, requestId } = arm;
      if (!settings || (ifIncarnation !== undefined && (!Number.isSafeInteger(ifIncarnation) || Number(ifIncarnation) < 0))
        || (ifServing !== undefined && (typeof ifServing !== 'string' || !ifServing || ifServing.length > 128))
        || (requestId !== undefined && (typeof requestId !== 'string' || !requestId || requestId.length > 128))) {
        return respond(refusal(400, 'SETTINGS_IMPORT_PRECONDITION_INVALID'));
      }
      const expected = { ...(ifIncarnation !== undefined ? { incarnation: Number(ifIncarnation) } : {}),
        ...(typeof ifServing === 'string' ? { serving: ifServing } : {}) };
      const run = () => write(req, settings, expected, typeof requestId === 'string' ? requestId : undefined, requestLifetime);
      if (typeof requestId !== 'string') return respond(await run());
      // The whole request decides "the same request": different values or preconditions under one id are a mismatch.
      const fingerprint = requestFingerprint({ settings, ifIncarnation: ifIncarnation ?? null, ifServing: ifServing ?? null });
      const remembered = answered.answer(options.caller?.(req) ?? '', requestId, fingerprint, run);
      if (remembered === 'mismatch') {
        return respond(refusal(400, 'SETTINGS_IMPORT_PRECONDITION_INVALID', undefined, {
          state: 'nothing was imported', next: ['Send a new requestId for a different import'] }));
      }
      return respond(await remembered);
    }
    if (arm.action === 'capture') {
      const settings = exact(arm, ['version', 'action', 'settings']) ? readSettings(arm.settings) : undefined;
      if (!settings) return respond(refusal(400, 'SETTINGS_IMPORT_PRECONDITION_INVALID'));
      const lifetime = synchronize();
      if (lifetime === null || lifetime !== requestLifetime) return respond(refusal(409, 'SETTINGS_IMPORT_PRECONDITION_STALE', 'stale'));
      try {
        const prepared = options.owner.prepare({ settings });
        const facts = options.owner.inspect(prepared);
        options.owner.assert(prepared);
        const authority = options.captureAuthority(req);
        if (authority === null || req.signal.aborted) return respond(refusal(409, 'SETTINGS_IMPORT_PRECONDITION_STALE', 'stale'));
        const { reference, expiresAt } = references.issue({ prepared, authority, lifetime });
        return Response.json({ settingsImportPrecondition: { version: 1, action: 'captured', reference, expiresAt, facts, serving: servingIdOf(lifetime) } });
      } catch (error) { return respond(refusal(409, isPairingStoreFault(error) ? 'PAIRING_STORE_FAULTED' : 'SETTINGS_IMPORT_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error))); }
    }
    if (arm.action !== 'apply' || !exact(arm, ['version', 'action', 'reference']) || typeof arm.reference !== 'string'
      || !arm.reference || arm.reference.length > 128) return respond(refusal(400, 'SETTINGS_IMPORT_PRECONDITION_INVALID'));
    const lifetime = synchronize();
    const { entry, spent: wasSpent } = references.take(arm.reference);
    if (!entry || lifetime === null || lifetime !== requestLifetime || entry.lifetime !== lifetime || entry.expiresAt <= Date.now()) {
      return respond(refusal(409, 'SETTINGS_IMPORT_PRECONDITION_STALE', wasSpent ? 'spent' : 'stale'));
    }
    const assertBound = () => {
      req.signal.throwIfAborted();
      if (options.lifetime() !== entry.lifetime || Date.now() >= entry.expiresAt) throw new Error('Settings import retired');
    };
    try {
      const receipt = await apply(req, entry.prepared, entry.authority, assertBound);
      return Response.json({ settingsImportPrecondition: { version: 1, action: 'applied', reference: arm.reference, receipt } });
    } catch (error) { return respond(refusal(409, 'SETTINGS_IMPORT_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error))); }
  } };
}

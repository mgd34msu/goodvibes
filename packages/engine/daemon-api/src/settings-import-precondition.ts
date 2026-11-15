import type { SettingsPreconditionReceipt } from './settings-precondition.js';
import { createSingleUseReferenceTable } from './single-use-reference-table.js';
import { isPairingStoreFault, settingsRefusalReason, type SettingsRefusalReason } from './settings-precondition.js';

/** Private authenticated ingress. Values never form hosted judgment evidence. */
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
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length && keys.every(key => fields.includes(key));
}
function refusal(status: number, code: string, reason?: SettingsRefusalReason): Response {
  return Response.json({ error: 'Settings import owner unavailable', code, ...(reason ? { reason } : {}) }, { status });
}
export function createSettingsImportPreconditionHandler<Prepared, Transition, Authority>(options: Options<Prepared, Transition, Authority>): SettingsImportPreconditionHandler {
  const references = createSingleUseReferenceTable<{ prepared: Prepared; authority: Authority; lifetime: object; expiresAt: number }>();
  const synchronize = () => {
    const current = options.lifetime();
    references.synchronize(current);
    return current;
  };
  return { lifetime: options.lifetime, async handle(req, payload, requestLifetime) {
    const arm = payload.settingsImportPrecondition;
    if (!exact(payload, ['settingsImportPrecondition']) || !record(arm) || arm.version !== 1) return refusal(400, 'SETTINGS_IMPORT_PRECONDITION_INVALID');
    if (arm.action === 'capture') {
      if (!exact(arm, ['version', 'action', 'settings']) || !Array.isArray(arm.settings) || !arm.settings.length
        || !arm.settings.every(entry => record(entry) && exact(entry, ['key', 'value']) && typeof entry.key === 'string' && entry.key.length > 0)) {
        return refusal(400, 'SETTINGS_IMPORT_PRECONDITION_INVALID');
      }
      const lifetime = synchronize();
      if (lifetime === null || lifetime !== requestLifetime) return refusal(409, 'SETTINGS_IMPORT_PRECONDITION_STALE', 'stale');
      try {
        // Structural validation precedes this copy; private values stay in the native owner.
        const settings = arm.settings.map(entry => ({ key: entry.key as string, value: entry.value }));
        const prepared = options.owner.prepare({ settings });
        const facts = options.owner.inspect(prepared);
        options.owner.assert(prepared);
        const authority = options.captureAuthority(req);
        if (authority === null || options.lifetime() !== lifetime || req.signal.aborted) return refusal(409, 'SETTINGS_IMPORT_PRECONDITION_STALE', 'stale');
        const { reference, expiresAt } = references.issue({ prepared, authority, lifetime });
        return Response.json({ settingsImportPrecondition: { version: 1, action: 'captured', reference, expiresAt, facts } });
      } catch (error) { return refusal(409, isPairingStoreFault(error) ? 'PAIRING_STORE_FAULTED' : 'SETTINGS_IMPORT_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error)); }
    }
    if (arm.action !== 'apply' || !exact(arm, ['version', 'action', 'reference']) || typeof arm.reference !== 'string'
      || !arm.reference || arm.reference.length > 128) return refusal(400, 'SETTINGS_IMPORT_PRECONDITION_INVALID');
    const lifetime = synchronize();
    const { entry, spent: wasSpent } = references.take(arm.reference);
    if (!entry || lifetime === null || lifetime !== requestLifetime || entry.lifetime !== lifetime || entry.expiresAt <= Date.now()) return refusal(409, 'SETTINGS_IMPORT_PRECONDITION_STALE', wasSpent ? 'spent' : 'stale');
    const assertBound = () => {
      req.signal.throwIfAborted();
      if (options.lifetime() !== entry.lifetime || Date.now() >= entry.expiresAt) throw new Error('Settings import retired');
    };
    try {
      assertBound(); options.owner.assert(entry.prepared);
      const receipt = await options.admit(req, entry.authority, entry.prepared, assertBound, (claim, assertAdmissionCurrent) =>
        options.owner.withPrepared(entry.prepared, () => options.withAuthority(req, entry.authority, assertAuthority => {
          const current = () => { assertAuthority(); assertBound(); assertAdmissionCurrent(); };
          current(); options.owner.assert(entry.prepared); claim(); current();
          const transition = options.owner.begin(entry.prepared);
          current(); options.owner.assertTransition(entry.prepared, transition);
          return options.owner.finish(entry.prepared, transition, current);
        }), assertAdmissionCurrent));
      return Response.json({ settingsImportPrecondition: { version: 1, action: 'applied', reference: arm.reference, receipt } });
    } catch (error) { return refusal(409, 'SETTINGS_IMPORT_PRECONDITION_UNAVAILABLE', settingsRefusalReason(error)); }
  } };
}

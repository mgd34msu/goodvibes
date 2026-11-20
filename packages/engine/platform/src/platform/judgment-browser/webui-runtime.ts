import {
  BrowserJudgmentError, missingScopes,
  type AuthenticatedPrincipal, type BrowserJudgmentBatteryId,
} from '@goodvibes/engine/daemon-api';
import type { GatewayMethodDescriptor } from '../control-plane/method-catalog-shared.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import { BrowserJudgmentReferences } from './references.js';
import { BrowserJudgmentRegistry } from './registry.js';
import { BrowserJudgmentService } from './service.js';
import type { BrowserJudgmentAuthorization, BrowserJudgmentRoute } from './types.js';
import { createWebuiCatalogProviderAdapter } from './batteries/webui-adapters.js';
import { snapshotWebuiCredentialNames } from './batteries/webui-readers.js';
import { granted, requireSynchronousAssertion } from './guards.js';

export type WebuiJudgmentSourceKind = 'provider-catalog-ids';

/** Source/purpose permission is owned by the host, separately from read scopes. */
export interface WebuiBrowserJudgmentOptions {
  /** Canonical identity metadata only. The host retains the original registry generation and provider owners. */
  readonly providerCatalog?: {
    readonly capture: () => {
      readonly snapshot: { readonly providerIds: readonly string[]; readonly catalogProviderIds: readonly string[] };
      readonly signal: AbortSignal;
      readonly assertCurrent: () => void;
    };
  };
  readonly methods: { get(id: string): GatewayMethodDescriptor | null };
  readonly currentRoute: () => BrowserJudgmentRoute | undefined;
  readonly authorize: (input: BrowserJudgmentAuthorization & { readonly sources: readonly WebuiJudgmentSourceKind[] }) => boolean;
}

const held = (): never => { throw new BrowserJudgmentError('JUDGMENT_REFERENCE_HELD'); };
function canRead(principal: AuthenticatedPrincipal, scopes: readonly string[]): boolean {
  return principal.admin === true || missingScopes(principal.scopes, scopes).length === 0;
}

/**
 * The real WebUI source owner. Only provider catalog ids enter this closed
 * registry; read-aloud splits text in the browser by code. Daemon refusals
 * carry their machine code, so the web UI reads them without a battery. Status
 * enums stay in the pure catalog; no dynamic status issuer is invented.
 */
export function createWebuiBrowserJudgment(options: WebuiBrowserJudgmentOptions): BrowserJudgmentService {
  const references = new BrowserJudgmentReferences();
  const registry = new BrowserJudgmentRegistry();
  const bindings = new Map<string, { readonly principalId: string; readonly principalKind: AuthenticatedPrincipal['principalKind']; readonly battery: BrowserJudgmentBatteryId;
    readonly sources: readonly WebuiJudgmentSourceKind[] }>();
  const remember = (id: string, principal: AuthenticatedPrincipal, battery: BrowserJudgmentBatteryId,
    sources: readonly WebuiJudgmentSourceKind[]) => {
    try {
      const lease = references.resolve(id, () => principal, battery, (value) => value);
      bindings.set(id, { principalId: principal.principalId, principalKind: principal.principalKind, battery, sources: Object.freeze([...sources]) });
      lease.signal!.addEventListener('abort', () => bindings.delete(id), { once: true });
      return id;
    } catch (error) { references.revoke(id); throw error; }
  };

  registry.register(createWebuiCatalogProviderAdapter(async (input, context) => {
    const battery = 'webui.models.catalog-provider-match';
    const principal = context.currentPrincipal();
    const { principalId, principalKind } = principal;
    const source = options.providerCatalog;
    const methods = ['providers.list', 'models.list'].map(id => options.methods.get(id));
    if (!source || methods.some(method => !method || (method.access === 'admin' && !principal.admin) || !canRead(principal, method.scopes))) return held();
    const captured = source.capture();
    const assertCurrent = () => {
      context.signal.throwIfAborted(); captured.signal.throwIfAborted();
      requireSynchronousAssertion(captured.assertCurrent, 'JUDGMENT_REFERENCE_HELD');
      const current = context.currentPrincipal();
      if (current.principalId !== principalId || current.principalKind !== principalKind
        || options.providerCatalog !== source || methods.some((method, index) => !method
          || options.methods.get(index === 0 ? 'providers.list' : 'models.list') !== method
          || (method.access === 'admin' && !current.admin) || !canRead(current, method.scopes))) return held();
    };
    assertCurrent();
    let snapshot;
    try {
      // The complete authoritative ID inventory is screened before request selection or hashing.
      const inventory = snapshotJudgmentInput(captured.snapshot) as typeof captured.snapshot;
      snapshot = snapshotWebuiCredentialNames(input);
      const validIds = (value: readonly string[]) => Array.isArray(value)
        && value.every(id => typeof id === 'string' && id.trim().length > 0 && id.length <= 128)
        && new Set(value).size === value.length;
      if (Object.keys(inventory).length !== 2 || !Object.hasOwn(inventory, 'providerIds') || !Object.hasOwn(inventory, 'catalogProviderIds')
        || !validIds(inventory.providerIds) || !validIds(inventory.catalogProviderIds)
        || !inventory.providerIds.includes(snapshot.providerId)
        || snapshot.keys.some(key => !inventory.catalogProviderIds.includes(key))) return held();
    } catch { throw new BrowserJudgmentError('JUDGMENT_INPUT_HELD'); }
    assertCurrent();
    const id = remember(references.issue({ principalId, battery, revision: crypto.randomUUID(),
      expiresAt: Date.now() + 300_000, snapshot, assertCurrent,
      mayRead: actor => actor.principalId === principalId && actor.principalKind === principalKind
        && methods.every(method => !!method && (method.access !== 'admin' || actor.admin === true) && canRead(actor, method.scopes)),
    }), principal, battery, ['provider-catalog-ids']);
    const revoke = () => references.revoke(id);
    captured.signal.addEventListener('abort', revoke, { once: true });
    try {
      const lease = references.resolve(id, context.currentPrincipal, battery, snapshotWebuiCredentialNames);
      lease.signal!.addEventListener('abort', () => captured.signal.removeEventListener('abort', revoke), { once: true });
      assertCurrent();
      return { ...lease, dispose: revoke };
    } catch (error) { captured.signal.removeEventListener('abort', revoke); revoke(); throw error; }
  }));
  return new BrowserJudgmentService({ registry, references, currentRoute: options.currentRoute,
    authorize(input) {
      const binding = bindings.get(input.sourceBinding);
      return !!binding && binding.principalId === input.principal.principalId && binding.principalKind === input.principal.principalKind && binding.battery === input.battery
        && granted(options.authorize({ ...input, sources: binding.sources }));
    },
  });
}

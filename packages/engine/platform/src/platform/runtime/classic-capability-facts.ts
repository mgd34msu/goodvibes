import { declaredClassicBoolean } from '../routing/classic-model-facts.js';

export const CLASSIC_RUNTIME_KINDS = ['process-output', 'pty-session', 'sudo-mediation', 'browser-desktop-receipt'] as const;
export const CLASSIC_RUNTIME_STATUSES = ['ready', 'running', 'completed', 'blocked', 'failed', 'attention', 'unknown'] as const;

/** Publisher declarations are native facts, never schema certification or permission to invoke a route. */
export function declaredClassicRuntimeMetadata(record: Readonly<Record<string, unknown>>): {
  readonly kind: typeof CLASSIC_RUNTIME_KINDS[number] | 'unassessed';
  readonly status: typeof CLASSIC_RUNTIME_STATUSES[number];
} {
  const kind = CLASSIC_RUNTIME_KINDS.find(value => value === record.kind) ?? 'unassessed';
  const statuses = ['status', 'state', 'outcome'].filter(key => Object.hasOwn(record, key) && record[key] !== undefined)
    .map(key => CLASSIC_RUNTIME_STATUSES.find(value => value === record[key]) ?? 'unknown');
  const status = statuses.length && new Set(statuses).size === 1 ? statuses[0] ?? 'unknown' : 'unknown';
  return { kind, status };
}

/** Exact publisher fields only. Descriptive prose never establishes capability or readiness. */
export function declaredClassicCapabilityEvidence(kind: 'mobile-touch' | 'pwa-runtime' | 'device-capability', record: unknown, requestedCapability?: string): boolean | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const data = record as Record<string, unknown>;
  if (kind === 'device-capability') {
    if (!requestedCapability) return null;
    const supported = declaredClassicBoolean(data.supported);
    const ready = declaredClassicBoolean(data.ready);
    const status = data.status ?? data.state;
    if (supported === false || ready === false || status === 'blocked' || status === 'disabled' || status === 'unavailable') return false;
    if (status !== 'ready' && supported !== true && ready !== true) return null;
    if (data.capabilityId === requestedCapability) return true;
    return Array.isArray(data.capabilities) && data.capabilities.some(value => value === requestedCapability) ? true : null;
  }
  const keys = kind === 'mobile-touch' ? ['mobileReady', 'touchReady', 'responsive', 'mobileStatus']
    : ['pwaReady', 'manifestReady', 'serviceWorkerReady', 'offlineReady', 'installReady', 'pwaStatus'];
  const containers = [data, ...['metadata', 'pwa', 'browser', 'evidence'].map(key => data[key])]
    .filter((value): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value));
  const values = new Set<boolean>();
  for (const container of containers) for (const key of keys) {
    const value = declaredClassicBoolean(container[key]);
    if (value !== null) values.add(value);
  }
  return values.size === 1 ? [...values][0] ?? null : null;
}

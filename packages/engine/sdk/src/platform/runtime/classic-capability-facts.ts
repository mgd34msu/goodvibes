import { declaredClassicBoolean } from '../routing/classic-model-facts.js';

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

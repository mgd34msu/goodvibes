/**
 * The runtime store's domains as inspectable domains, so one state inspector
 * shows every slice the store holds. Reading a domain is a property read; the
 * state is serialized and masked only when a snapshot is asked for.
 */
import type { InspectableDomain } from '../../diagnostics/panels/state-inspector.js';
import type { RuntimeState } from '../../store/state.js';

/** The store surface the adapters read. */
export interface InspectableRuntimeStore {
  getState(): RuntimeState;
}

function numberField(value: unknown, key: 'revision' | 'lastUpdatedAt'): number {
  if (value === null || typeof value !== 'object') return 0;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'number' ? field : 0;
}

/** One inspectable domain per top-level slice of the store, in the store's own order. */
export function runtimeStoreDomains(store: InspectableRuntimeStore): InspectableDomain[] {
  return Object.keys(store.getState()).map((name): InspectableDomain => ({
    name,
    getState: () => {
      const value = (store.getState() as unknown as Record<string, unknown>)[name];
      return value !== null && typeof value === 'object' ? value as Record<string, unknown> : { value };
    },
    getRevision: () => numberField((store.getState() as unknown as Record<string, unknown>)[name], 'revision'),
    getLastUpdatedAt: () => numberField((store.getState() as unknown as Record<string, unknown>)[name], 'lastUpdatedAt'),
  }));
}

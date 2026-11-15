/**
 * memory-consolidation-gate.ts, local consolidation runs only while this
 * process is the memory store's one writer.
 *
 * When the TUI is attached to a daemon the daemon owns the store and runs its
 * own consolidation; the local registry is only the image loaded at boot. A
 * local pass over it would write into the daemon's file as a second writer, so
 * while the memory spine is routing through the daemon the scheduler is shown
 * an empty store and has nothing to merge, decay or archive. Once the spine
 * returns to local access it reloads the store and consolidation resumes.
 */
import type { MemoryRegistry } from '@goodvibes-jev/engine/platform/platform/state';

export function gateConsolidationToLocalWriter(registry: MemoryRegistry, spine: { readonly active: boolean }): MemoryRegistry {
  return new Proxy(registry, {
    get(target, property) {
      if (property === 'getAll') return () => (spine.active ? [] : target.getAll());
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Model picker UI data surface barrel.
 *
 * Re-exports the picker entry types. The entries themselves are built by
 * `enrichModelEntries` (health-enrichment.ts).
 */
export type {
  CapabilityFlags,
  ProviderLatencyStats,
  ProviderHealthContext,
  ModelPickerEntry,
  ModelPickerGroup,
} from './types.js';
// ProviderStatus re-exported from types for convenience
export type { ProviderStatus } from './types.js';

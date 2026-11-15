/**
 * Runtime UI data surface barrel.
 *
 * Exports the model picker entry types and the provider health status types.
 *
 * These modules produce structured data for renderers, no UI rendering
 * logic lives here.
 */

export type {
  CapabilityFlags,
  ProviderLatencyStats,
  ProviderHealthContext,
  ModelPickerEntry,
  ModelPickerGroup,
} from './model-picker/index.js';
export type { ProviderStatus as ModelPickerProviderStatus } from './model-picker/index.js';

export type { ProviderStatus, CompositeHealthStatus } from './provider-health/index.js';

/**
 * Runtime UI data surface barrel.
 *
 * Exports the provider health status types. The model picker itself lives in
 * terminal-shell (model-picker*.ts) and reads provider reachability from the
 * provider registry.
 *
 * These modules produce structured data for renderers, no UI rendering
 * logic lives here.
 */

export type { ProviderStatus, CompositeHealthStatus } from './provider-health/index.js';

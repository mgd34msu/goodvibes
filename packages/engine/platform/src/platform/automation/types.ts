/**
 * Shared automation type vocabulary used across jobs, runs, routes, delivery,
 * watchers, and control-plane domains.
 */

import type { TransportSurfaceKind } from '../../events/surfaces.js';

export type AutomationJobStatus = 'enabled' | 'paused' | 'error' | 'archived';
export type AutomationRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'missed';
export type AutomationRunTrigger =
  | 'scheduled'
  | 'manual'
  | 'catch_up'
  | 'webhook'
  | 'surface'
  | 'watcher';

/**
 * The transport surface axis for routes, channels, and delivery. Collapsed onto
 * the canonical {@link TransportSurfaceKind} (= the strict route-binding list in
 * events/routes.ts) so there is no longer a parallel literal union to drift.
 * This is the STRICT set, product surfaces (agent/webui/companion) live only on
 * the wider {@link SurfaceKind} used by the participant/message identity axis.
 */
export type AutomationSurfaceKind = TransportSurfaceKind;

export type AutomationRouteKind = 'session' | 'thread' | 'channel' | 'message';
export type AutomationSourceKind =
  | 'schedule'
  | 'manual'
  | 'hook'
  | 'webhook'
  | 'surface'
  | 'watcher';
export type AutomationExecutionKind = 'isolated' | 'current' | 'pinned' | 'background' | 'main';
export type AutomationExecutionTargetKind = AutomationExecutionKind | 'session' | 'route';
export type AutomationDeliveryKind = 'none' | 'webhook' | 'surface' | 'integration' | 'link';
export type ProviderRoutingSelection = 'inherit-current' | 'concrete' | 'synthetic';
export type ProviderFailurePolicy = 'ordered-fallbacks' | 'fail';
export type AutomationExecutionMode = 'spawn' | 'shared-session' | 'continued-live' | 'background';
export type AutomationSessionPolicy = 'create-or-bind' | 'continue-existing' | 'require-existing';
export type AutomationThreadPolicy = 'preserve' | 'replace' | 'detached';
export type AutomationDeliveryGuarantee = 'best-effort' | 'at-least-once';

export interface ProviderModelRoutingPolicy {
  readonly providerSelection?: ProviderRoutingSelection | undefined;
  readonly providerFailurePolicy?: ProviderFailurePolicy | undefined;
  readonly fallbackModels?: readonly string[] | undefined;
}

export interface AutomationExecutionIntent {
  readonly mode: AutomationExecutionMode;
  readonly targetKind: AutomationExecutionTargetKind;
}

export interface AutomationEntityBase {
  readonly id: string;
  readonly labels: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly createdBy?: string | undefined;
  readonly updatedBy?: string | undefined;
  readonly notes?: string | undefined;
}

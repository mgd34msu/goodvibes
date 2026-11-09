import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
export type CommonSettingsCategory =
  | 'display'
  | 'ui'
  | 'provider'
  | 'pricing'
  | 'subscriptions'
  | 'behavior'
  | 'storage'
  | 'atRest'
  | 'permissions'
  | 'orchestration'
  | 'planner'
  | 'contract'
  | 'judgment'
  | 'tools'
  | 'helper'
  | 'tts'
  | 'voice'
  | 'service'
  | 'daemon'
  | 'controlPlane'
  | 'httpListener'
  | 'web'
  | 'network'
  | 'relay'
  | 'surfaces'
  | 'device'
  | 'conversationGate'
  | 'cloudflare'
  | 'batch'
  | 'automation'
  | 'checkin'
  | 'watchers'
  | 'runtime'
  | 'telemetry'
  | 'cache'
  | 'diagnostics'
  | 'sandbox'
  | 'mcp'
  | 'learning'
  | 'fetch'
  | 'agents'
  | 'security'
  | 'integrations'
  | 'policy'
  | 'notifications'
  | 'release'
  | 'update'
  | 'power'
  | 'memory'
  | 'payments'
  | 'profile'
  | 'occasions'
  | 'hostedSessions'
  | 'email'
  | 'calendar'
  | 'google'
  | 'danger';
export type SettingsFocusRegion = 'categories' | 'settings';
export type SettingsValueSource = 'default' | 'local' | 'synced' | 'managed';
export interface CommonSettingEntryState<Source extends string = SettingsValueSource> {
  currentValue: unknown;
  isDefault: boolean;
  effectiveSource?: Source;
  locked?: boolean;
  conflict?: boolean;
  sourceLabel?: string;
  lockReason?: string;
  metadataUnavailable?: string;
}
export interface McpEntry {
  name: string;
  connected: boolean;
  role: string;
  trustMode: 'constrained' | 'ask-on-risk' | 'allow-all' | 'blocked';
  allowedPaths: string[];
  allowedHosts: string[];
}
export interface SettingsModalChange<Key extends string = ConfigKey> {
  readonly key: Key;
  readonly previousValue: unknown;
  readonly value: unknown;
}
export interface SettingsModalChangeResult {
  readonly message?: string;
}
export type SettingsModalChangeHandler<Key extends string = ConfigKey> = (
  change: SettingsModalChange<Key>,
) => SettingsModalChangeResult | void;

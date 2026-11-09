/**
 * The judgment port's config types: the `judgment` category shape, the
 * `judgment.*` key union and the value of each key. Defaults and setting
 * definitions live in schema-domain-judgment.ts; the port is built from them in
 * runtime/judgment-services.ts.
 */

/** Where the judgment API key is read from. */
export type JudgmentKeySource = 'env' | 'secret' | 'none';
import type { DecisionModelPolicy } from '@goodvibes-jev/engine/errors';

import type { JudgmentBackendSettings } from '@goodvibes-jev/judgment/decisions';

/** A compatible endpoint and a credential name, never a credential value. */
export interface JudgmentFallbackSettings {
  readonly endpoint: string;
  readonly model: string;
  readonly keySource: JudgmentKeySource;
  readonly keyName: string;
  readonly backend?: JudgmentBackendSettings;
}

import type { JudgmentVolumeMonitorControl } from '../observe/judgment-volume-monitor.js';

export interface JudgmentSettings {
  /** Optional owner-configured local call-volume alerts. */
  volumeMonitor?: Partial<JudgmentVolumeMonitorControl>;
  /** Missing on older installations; defaults to Default - On. */
  policy?: DecisionModelPolicy;
  /** System One endpoint base URL; empty uses TYPESAFE_BASE_URL, then the hosted endpoint. */
  endpoint: string;
  /** `env` reads TYPESAFE_API_KEY from the process environment; `secret` reads it from the secret store. */
  keySource: JudgmentKeySource;
  /** Credential reference for the primary target; omitted uses TYPESAFE_API_KEY. */
  keyName?: string;
  /** Judgment model or alias; empty uses TYPESAFE_DEFAULT_MODEL, then jev-latest. */
  model: string;
  /** Optional protocol, complete-input limits and explicit response aliases. */
  backend?: JudgmentBackendSettings;
  /** Timeout per judgment attempt in milliseconds. */
  timeoutMs: number;
  /** Ordered compatible endpoints. An explicit empty list disables inherited fallbacks. */
  fallbacks: readonly JudgmentFallbackSettings[];
}

export type JudgmentConfigKey =
  | 'judgment.volumeMonitor'
  | 'judgment.policy'
  | 'judgment.endpoint'
  | 'judgment.keySource'
  | 'judgment.keyName'
  | 'judgment.model'
  | 'judgment.backend'
  | 'judgment.timeoutMs'
  | 'judgment.fallbacks';

/** The value of every `judgment.*` key, folded into ConfigValue with one arm. */
export interface JudgmentConfigValueMap {
  'judgment.volumeMonitor': Partial<JudgmentVolumeMonitorControl>;
  'judgment.policy': DecisionModelPolicy;
  'judgment.endpoint': string;
  'judgment.keySource': JudgmentKeySource;
  'judgment.keyName': string;
  'judgment.model': string;
  'judgment.backend': JudgmentBackendSettings;
  'judgment.timeoutMs': number;
  'judgment.fallbacks': readonly JudgmentFallbackSettings[];
}

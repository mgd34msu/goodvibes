/**
 * The judgment port's config types: the `judgment` category shape, from which
 * the `judgment.*` keys and their values are read. Defaults and setting
 * definitions live in schema-domain-judgment.ts; the port is built from them in
 * runtime/judgment-services.ts.
 */

/** Where the judgment API key is read from. */
export type JudgmentKeySource = 'env' | 'secret' | 'none';
import type { DecisionModelPolicy } from '@goodvibes/engine/errors';

import type { JudgmentBackendSettings } from '@goodvibes/judgment/decisions';

/** A compatible endpoint and a credential name, never a credential value. */
export interface JudgmentFallbackSettings {
  readonly endpoint: string;
  readonly model: string;
  readonly keySource: JudgmentKeySource;
  readonly keyName: string;
  readonly backend?: JudgmentBackendSettings;
}

import type { JudgmentVolumeMonitorControl } from '../observe/judgment-volume-monitor.js';

/**
 * Decision-model settings moved aside, as they were: what a home that had
 * decision models switched off (No Decision Model, 3.5.0 and earlier) held, kept
 * so that choosing a decision model again in Settings offers them back. Never a
 * credential: `keyName` is a reference name, like `judgment.keyName`.
 */
export interface JudgmentSetAside {
  readonly endpoint?: string;
  readonly model?: string;
  readonly keySource?: JudgmentKeySource;
  readonly keyName?: string;
  readonly backend?: JudgmentBackendSettings;
  readonly fallbacks?: readonly JudgmentFallbackSettings[];
}

export interface JudgmentSettings {
  /** Optional owner-configured local call-volume alerts. */
  volumeMonitor?: Partial<JudgmentVolumeMonitorControl>;
  /** Missing on older installations; defaults to Hybrid. */
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
  /** Decision-model settings moved aside (empty when none are); Settings offers them back. */
  setAside: JudgmentSetAside;
  /** No decision model chosen: none is asked, whatever the environment holds (config/decision-model-set.ts). */
  noDecisionModel: boolean;
}

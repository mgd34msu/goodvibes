import type { JudgmentPort, Questions, Reading } from '@goodvibes/judgment/decisions';
import type {
  AuthenticatedPrincipal, BrowserJudgmentBatteryVersion, BrowserJudgmentBatteryId, BrowserJudgmentInputMap, BrowserJudgmentValueMap,
} from '@goodvibes/engine/daemon-api';
import type { BrowserJudgmentReferences } from './references.js';

export type BrowserJudgmentProjection<V> =
  | { readonly status: 'settled'; readonly value: V; readonly readings: Readonly<Record<string, Reading>> }
  | { readonly status: 'held'; readonly reason: 'uncertain'; readonly readings: Readonly<Record<string, Reading>>;
      /** Server-only minimum outcome for compound uncertainty; never lowers an item outcome. */
      readonly compoundOutcome?: 'confirm' | 'escalate' };

/** Produced only by the server resolver. A reference proves read access, not outbound permission. */
export interface BrowserJudgmentResolvedInput<S> {
  readonly state: S;
  readonly sourceBinding: string;
  /** Optional owned lifetime; expiry or revocation cancels an admitted wait immediately. */
  readonly signal?: AbortSignal;
  /** Throws a value-free hold if source revision, permission, or lifetime changed. */
  readonly assertCurrent: () => void;
  /** Release an operation-local snapshot after its actual work has drained. */
  readonly dispose?: () => void;
}
export interface BrowserJudgmentResolveContext {
  readonly principal: AuthenticatedPrincipal;
  /** Fresh transport identity/scopes; reference assertions must use this rather than a cached grant. */
  readonly currentPrincipal: () => AuthenticatedPrincipal;
  readonly signal: AbortSignal;
  readonly references: BrowserJudgmentReferences;
}
/** Executable adapter around an existing Battery or named pattern; never received over HTTP. */
export interface BrowserJudgmentBattery<K extends BrowserJudgmentBatteryId, S, R> {
  readonly id: K;
  readonly version: BrowserJudgmentBatteryVersion<K>;
  /** Fixed questions only. Dynamic state must not be embedded in logged questions. */
  readonly questions: Questions;
  readonly maxCalls: number;
  readonly resolve: (input: BrowserJudgmentInputMap[K], context: BrowserJudgmentResolveContext) => Promise<BrowserJudgmentResolvedInput<S>>;
  readonly run: (port: JudgmentPort, state: S, options: { readonly signal: AbortSignal }) => Promise<R>;
  readonly project: (result: R) => BrowserJudgmentProjection<BrowserJudgmentValueMap[K]>;
  /**
   * Retain what was prepared for the client (`recordAction`). The service calls it only after the
   * projection validated and the response is about to be returned, so the decision log never says
   * 'ready' for a result the client was refused. `project` itself must not record.
   */
  readonly record?: (result: R, projection: BrowserJudgmentProjection<BrowserJudgmentValueMap[K]>) => void;
}
/** Acquired by server composition. Neither route identity nor port comes from browser JSON. */
export interface BrowserJudgmentRoute {
  /** Revoking the configured route cancels pending key acquisition and retry waits. */
  readonly signal?: AbortSignal;
  readonly revision: string;
  readonly kind: 'hosted' | 'local';
  /** Server-owned destinations available to the configured failover chain. */
  readonly endpointKinds?: readonly ('hosted' | 'local')[];
  readonly port: JudgmentPort;
  readonly assertCurrent: () => void;
}
export interface BrowserJudgmentAuthorization {
  readonly principal: AuthenticatedPrincipal;
  readonly battery: BrowserJudgmentBatteryId;
  readonly batteryVersion: BrowserJudgmentBatteryVersion;
  readonly sourceBinding: string;
  readonly route: Pick<BrowserJudgmentRoute, 'revision' | 'kind'>;
}

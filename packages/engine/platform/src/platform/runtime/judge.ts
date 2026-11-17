/**
 * The engine's door to the one judgment request. A decision site names its
 * battery, the state, how to settle the readings and its fallback; this
 * supplies the installed port and the operation's decision-model policy, so
 * `judgment.policy: No Decision Model` and a missing port take the fallback at
 * once without a request or a decision-log write.
 */
import {
  judge as judgeWithPort,
  type BatteryItems,
  type JudgeOptions,
  type JudgeOutcome,
  type JudgmentPort,
} from '@goodvibes-jev/judgment';
import { DecisionModelsDisabledError, JudgmentPortMissingError, judgmentPort } from '@goodvibes-jev/engine/errors';
import { isClassicOperation } from './decision-policy.js';

export {
  createJudgeCache,
  forgetProcessJudgments,
  type BandedReadings,
  type JudgeCache,
  type JudgeCacheOption,
  type JudgeCacheScope,
  type JudgeFallbackReason,
  type JudgeOutcome,
} from '@goodvibes-jev/judgment';

export interface EngineJudgeOptions<Items extends BatteryItems, R> extends Omit<JudgeOptions<Items, R>, 'port' | 'off'> {
  /** A port to ask instead of the installed one (a composition that owns its own). */
  readonly port?: JudgmentPort;
}

/** The installed port, or undefined with the reason the fallback applies. */
function installedPort(site: string): { readonly port: JudgmentPort } | { readonly off: boolean } {
  try { return { port: judgmentPort(site) }; }
  catch (error) {
    if (error instanceof DecisionModelsDisabledError) return { off: true };
    if (error instanceof JudgmentPortMissingError) return { off: false };
    throw error;
  }
}

/**
 * Asks one battery about one state with a deadline (the caller's, else
 * `judgment.decisionDeadlineMs`), an optional cache and a fallback. Resolves
 * with the value and where it came from; rejects only when the caller's
 * signal is aborted or `settle` throws.
 */
export function judge<const Items extends BatteryItems, R>(o: EngineJudgeOptions<Items, R>): Promise<JudgeOutcome<R>> {
  if (o.port === undefined && isClassicOperation()) return judgeWithPort({ ...o, port: undefined, off: true });
  const resolved = o.port === undefined ? installedPort(o.site) : { port: o.port };
  return 'port' in resolved
    ? judgeWithPort({ ...o, port: resolved.port })
    : judgeWithPort({ ...o, port: undefined, off: resolved.off });
}

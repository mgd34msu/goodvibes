/**
 * harness-mutation-format.ts, how a completed settings write is reported.
 *
 * Its own file because the reply is where two hard-won facts have to show up
 * together, and both of them cost a real session:
 *
 *  - the OWNER and the STORE. "Saved" alone cannot distinguish a value the
 *    acting runtime will read from one written into a file it never opens.
 *  - the COMPANION row. `voice.wake.enabled` on a surface whose
 *    `voice.wake.surfaces.<surface>` row is off is a setting that configures
 *    nothing; the write takes that row with it, and this is where it says so.
 */
import type { HarnessSettingMutationResult } from './harness-control.ts';
import { configKeyFacts, displaySettingValue } from '@goodvibes-jev/engine/platform/platform/config';

/** A credential key's value through the one display projection (`(secret)` or its reference); any other as written. */
function shownValue(key: string, value: unknown): string {
  return configKeyFacts(key).secret ? displaySettingValue(key, value) : String(value);
}

/** Render a completed settings mutation, naming what else moved and where it landed. */
export function formatHarnessMutation(result: HarnessSettingMutationResult): string {
  return [
    `Setting ${result.action}`,
    `  key ${result.key}`,
    `  previous ${shownValue(result.key, result.previous)}`,
    `  current ${shownValue(result.key, result.current)}`,
    ...(result.alsoSet ? [`  also set ${result.alsoSet.key} to ${String(result.alsoSet.value)}, ${result.alsoSet.message}`] : []),
    ...(result.alsoSetFailed ? [`  warning ${result.alsoSetFailed}`] : []),
    ...(result.secretNotDeleted ? [`  warning ${result.secretNotDeleted}`] : []),
    ...(result.scope ? [`  owner ${result.scope}`] : []),
    ...(result.appliedBy ? [`  applied by ${result.appliedBy}`] : []),
    ...(result.persistedTo ? [`  stored in ${result.persistedTo}`] : []),
  ].join('\n');
}

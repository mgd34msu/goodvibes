/** Checks for rows read back from the trigger store. A valid row does not
 * confirm a grant; fire-time approval ownership remains in grants.ts.
 */
import { validateArgv, validateDefinition } from './validation.js';
import type { TriggerActionGrant, TriggerEventLogEntry, TriggerRecord, TriggerRecoveryReport } from './types.js';
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const optional = (entry: Record<string, unknown>, key: string, check: (value: unknown) => boolean) => entry[key] === undefined || check(entry[key]);
const oneOf = (value: unknown, choices: readonly string[]) => typeof value === 'string' && choices.includes(value);
function approval(value: unknown): boolean {
  if (!object(value) || Object.keys(value).length !== 4 || value['version'] !== 1 || !strings(value['args']) || !(value['cwd'] === null || text(value['cwd']))) return false;
  try { validateArgv(value['command'], value['args'], 'approval'); return true; } catch { return false; }
}
function observation(value: unknown): boolean {
  return object(value) && finite(value['at']) && 'value' in value && text(value['text']) && (value['numeric'] === null || finite(value['numeric']))
    && optional(value, 'hash', text) && optional(value, 'truncated', entry => typeof entry === 'boolean');
}
function termination(value: unknown): boolean {
  return object(value) && oneOf(value['state'], ['exited', 'signalled', 'timed-out', 'unknown'])
    && oneOf(value['reason'], ['normal', 'nonzero-exit', 'signal', 'max-duration', 'daemon-restart', 'cancelled'])
    && (value['exitCode'] === null || (finite(value['exitCode']) && Number.isInteger(value['exitCode'])))
    && (value['signal'] === null || text(value['signal'])) && typeof value['timedOut'] === 'boolean'
    && finite(value['startedAt']) && finite(value['endedAt']) && finite(value['durationMs']) && value['durationMs'] >= 0 && text(value['command']) && strings(value['args'])
    && (value['pid'] === null || count(value['pid'])) && text(value['stdoutTail']) && text(value['stderrTail']) && typeof value['observed'] === 'boolean';
}
function run(value: unknown): boolean {
  return object(value) && finite(value['at']) && oneOf(value['outcome'], ['checked', 'fired', 'failed', 'suppressed', 'skipped'])
    && optional(value, 'detail', text) && optional(value, 'actionResult', text) && optional(value, 'durationMs', finite)
    && optional(value, 'observation', observation) && optional(value, 'termination', termination);
}
function definition(value: unknown): boolean {
  // Field-level shape is owned by validateDefinition, so a definition accepted at create is never refused at save.
  if (!object(value) || !finite(value['createdAt'])) return false;
  try { validateDefinition(value, { persisted: true }); } catch { return false; }
  const action = value['action'];
  return object(action) && optional(action, 'approvedAction', approval);
}
export function isTriggerRecord(value: unknown): value is TriggerRecord {
  if (!object(value) || !definition(value['definition']) || !oneOf(value['state'], ['idle', 'running', 'backoff', 'circuit-open', 'firing', 'fired', 'cancelled', 'failed'])
    || !Array.isArray(value['observations']) || !value['observations'].every(observation) || !Array.isArray(value['runs']) || !value['runs'].every(run)
    || !count(value['strikes']) || !count(value['backoffRung']) || !count(value['firedCount']) || !count(value['droppedLines']) || !finite(value['updatedAt'])
    || !optional(value, 'nextCheckAt', finite) || !optional(value, 'lastError', text) || !optional(value, 'lastFiredAt', finite)
    || !optional(value, 'pendingExit', termination)) return false;
  const rule = value['ruleState'];
  if (!object(rule) || !optional(rule, 'armed', entry => typeof entry === 'boolean') || !optional(rule, 'lastMatched', entry => typeof entry === 'boolean')
    || !optional(rule, 'streak', count) || !optional(rule, 'dedupMarks', entry => object(entry) && Object.values(entry).every(finite))) return false;
  const process = value['process'];
  return process === undefined || (object(process) && text(process['processId']) && process['processId'].length > 0 && count(process['pid'])
    && finite(process['startedAt']) && text(process['command']) && strings(process['args']) && text(process['daemonBootId']));
}
export function isTriggerGrant(value: unknown): value is TriggerActionGrant {
  if (!object(value) || !text(value['id']) || !value['id'] || !text(value['description']) || !text(value['confirmedBy']) || !value['confirmedBy']
    || !finite(value['createdAt']) || !finite(value['confirmedAt']) || !text(value['digest']) || !optional(value, 'cwd', text)) return false;
  try { validateArgv(value['command'], value['args'], 'grant'); } catch { return false; }
  if (/^[0-9a-f]{64}$/.test(value['digest'])) return optional(value, 'approvedAction', approval);
  return /^grant-revision-v1:[0-9a-p]{32}$/.test(value['digest']) && approval(value['approvedAction']);
}
export function isTriggerEvent(value: unknown): value is TriggerEventLogEntry {
  return object(value) && finite(value['at']) && text(value['triggerId']) && oneOf(value['kind'], ['stream', 'condition', 'on-exit'])
    && oneOf(value['event'], ['fired', 'failed', 'observed']) && text(value['fingerprint']);
}
export function isTriggerReport(value: unknown): value is TriggerRecoveryReport {
  return object(value) && finite(value['at']) && oneOf(value['reason'], ['startup', 'sweep']) && strings(value['reapedIds']) && strings(value['orphanedProcesses'])
    && ['triggersLoaded', 'triggersReaped', 'runsReaped', 'observationsReaped', 'eventsReaped'].every(key => count(value[key])) && optional(value, 'quarantined', text);
}

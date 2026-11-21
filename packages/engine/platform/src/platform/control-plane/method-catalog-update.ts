/**
 * method-catalog-update.ts, asking a daemon whether it is keeping itself current.
 *
 * The self-update loop already knew all of this: its cadence, how many checks
 * in a row had thrown and what the last one said, a release it had downloaded
 * and verified and was holding until the daemon went idle, and a release a
 * crash-loop rollback had rejected and will not reinstall. All of it lived in
 * one process's memory and a log file, so the only way to answer "is this
 * daemon updating itself" was shell access to the host.
 *
 * That is the gap these two verbs close, and the reason it matters is on the
 * record: a daemon whose update checks had been failing stayed on an old build
 * while three releases shipped, and every surface reported it as healthy,
 * because "has not updated" and "cannot update" produce identical silence.
 *
 * `update.check` runs the SAME tick the schedule runs, not a second path, so
 * an on-demand check and the hourly one cannot come to different conclusions.
 * It does not force an install: a verified swap still waits for a moment when
 * no work is in flight, which is what `pendingVersion` reports.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  NUMBER_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  methodDescriptor,
  objectSchema,
} from './method-catalog-shared.js';
import { enumSchema } from './operator-contract-schemas-shared.js';

const UPDATE_TRANSACTION_RECEIPT_SCHEMA = objectSchema({
  operation: enumSchema(['update', 'rollback']),
  phase: enumSchema(['claim', 'stage', 'admission', 'commit', 'cleanup']),
  committed: BOOLEAN_SCHEMA,
  recoveryRequired: BOOLEAN_SCHEMA,
  targets: arraySchema(STRING_SCHEMA),
  // Paths kept for inspection; the updater never overwrites them.
  recoveryPaths: arraySchema(STRING_SCHEMA),
  recoveryErrors: arraySchema(STRING_SCHEMA),
}, ['operation', 'phase', 'committed', 'recoveryRequired', 'targets', 'recoveryPaths', 'recoveryErrors']);

const UPDATE_STATUS_PROPERTIES = {
  armed: BOOLEAN_SCHEMA,
  offReason: STRING_SCHEMA,
  currentVersion: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
  releasesUrl: STRING_SCHEMA,
  checkIntervalMs: { anyOf: [NUMBER_SCHEMA, { type: 'null' }] },
  firstCheckDelayMs: { anyOf: [NUMBER_SCHEMA, { type: 'null' }] },
  failedCheckCount: NUMBER_SCHEMA,
  lastCheckFailure: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
  pendingVersion: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
  pendingSince: { anyOf: [NUMBER_SCHEMA, { type: 'null' }] },
  pendingBlockedBy: arraySchema(STRING_SCHEMA),
  rejectedVersion: { anyOf: [STRING_SCHEMA, { type: 'null' }] },
  // Present only while an interrupted update or rollback fences the loop.
  recoveryRequired: { type: 'boolean', enum: [true] },
  transactionRecovery: { anyOf: [UPDATE_TRANSACTION_RECEIPT_SCHEMA, { type: 'null' }] },
};
const UPDATE_STATUS_REQUIRED = [
  'armed', 'offReason', 'currentVersion', 'releasesUrl', 'checkIntervalMs',
  'firstCheckDelayMs', 'failedCheckCount', 'lastCheckFailure', 'pendingVersion', 'pendingSince', 'pendingBlockedBy', 'rejectedVersion',
];
const UPDATE_STATUS_SCHEMA = objectSchema(UPDATE_STATUS_PROPERTIES, UPDATE_STATUS_REQUIRED);
const UPDATE_CHECK_SCHEMA = objectSchema({
  ...UPDATE_STATUS_PROPERTIES,
  check: enumSchema(['ran', 'already-in-flight', 'loop-off', 'installing']),
}, [...UPDATE_STATUS_REQUIRED, 'check']);

export const builtinGatewayUpdateMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'update.status',
    title: 'Self-Update Status',
    description: 'Whether this daemon is keeping itself current, and, when it is not, the reason in one line. `armed` is false whenever no loop is running and `offReason` says which gate stopped it: update.auto not set, no artifact identity (a host that manages its own updates), or no release URL to resolve tags from. `failedCheckCount` with `lastCheckFailure` is the case that used to be invisible: checks running on schedule and failing every time, which looks exactly like having nothing to update to. `pendingVersion` is a release already downloaded and verified, waiting for a moment when no work is in flight; `pendingSince` says since when a release has waited and `pendingBlockedBy` names the fleet ids of the work it waits behind (the owner is told once after 24 hours). `rejectedVersion` is a release that was installed here, failed to start, and was rolled back, it is deliberately not reinstalled. `recoveryRequired` (true) and `transactionRecovery` appear only while an interrupted update or rollback fences the loop: `transactionRecovery.recoveryPaths` lists the retained files to inspect, `recoveryErrors` what went wrong, and the loop stays off until they are dealt with.',
    category: 'control-plane',
    effects: ['control-plane.read'],
    transport: ['ws'],
    // Declared and empty rather than omitted: the invoke gate skips a verb with
    // no typed inputSchema, so "takes nothing" has to be stated to be enforced.
    inputSchema: objectSchema({}, []),
    outputSchema: UPDATE_STATUS_SCHEMA,
  }),
  methodDescriptor({
    id: 'update.check',
    repeat: 'safe',
    title: 'Check For An Update Now',
    description: 'Run one update check immediately instead of waiting for the next interval, and return the status afterwards. This is the same tick the schedule runs, so an on-demand check and the hourly one cannot reach different conclusions. It never forces an install: a downloaded-and-verified release still waits for a moment when no work is in flight, which the returned `pendingVersion` reports. A check that fails is reported in `failedCheckCount` and `lastCheckFailure` rather than refused, the caller asked what the state is, and "the check failed" is the answer. `check` says what the call did: `ran` (a check ran now), `already-in-flight` (another check was still running, none was started, and the rest of the answer is as of now) or `loop-off` (no loop is armed, `offReason` says why, and nothing ran) or `installing` (a check ran now, found `pendingVersion`, and the daemon is installing it and will restart into it; this answer is sent before the install starts, so the daemon stops answering shortly after it).',
    category: 'control-plane',
    effects: ['control-plane.administer'],
    transport: ['ws'],
    inputSchema: objectSchema({}, []),
    outputSchema: UPDATE_CHECK_SCHEMA,
  }),
];

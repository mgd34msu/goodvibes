import { decisionOrClassic } from '../runtime/decision-policy.js';
/**
 * credential-read-defaults.ts: whether a read-only tool call touches secret or
 * credential material.
 *
 * This module used to hold a shipped list of credential-store path globs
 * (~/.ssh, ~/.aws/credentials, browser login databases...) and managed deny
 * rules built from it. What the list decided was "does reading this path
 * expose secrets", and it decided every unlisted path by omission: a token in
 * `~/.config/gh/hosts.yml`, a `.env.production` or a keystore anywhere else read
 * as harmless. That is a judgment about what a file holds, so it is now Jev's
 * reading: the side-effect battery's `secrets` question, asked for a call of a
 * built-in read-only tool (read, find, analyze, inspect, state, registry and
 * the other read-category tools). It is not asked per file a search or map
 * surfaces: that filter is `PermissionManager.readAccess`, which applies only
 * the owner's read rules, so a model reading every candidate file would
 * multiply cost on a large search.
 *
 * A yes (or an uncertain reading) sends the call through the gate's full
 * reading, where touching secrets is at least high stakes. Readings are kept
 * per call for the life of the process, so a path read twice is asked once.
 * Classic routes unresolved reads to secret-aware owner approval without
 * claiming that a file contains secrets or issuing a semantic request.
 */
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import { judgmentPort } from '@goodvibes/engine/errors';
import type { JudgmentPort } from '@goodvibes/judgment';
import { sideEffect } from '../gate/batteries/side-effect.js';
import { readingState } from '../gate/reading.js';

/**
 * Readings are kept per installed judgment port and per model it reports: a
 * verdict one model gave never answers for another, whether the model change
 * installs a new port or only changes the model setting of the installed one.
 */
let SEEN = new WeakMap<JudgmentPort, Map<string, boolean>>();
const SEEN_LIMIT = 2_048;

/** The decision site read-only secrets readings are logged under. */
export const READ_SECRETS_SITE = 'engine.gate.read-secrets';

/**
 * Whether a read-only tool call touches secret or credential material, read
 * by Jev (`engine.gate.side-effect`, `secrets`). Uncertain counts as yes.
 */
export async function readTouchesSecrets(toolName: string, args: Record<string, unknown>, workingDirectory?: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const state = readingState(toolName, args, workingDirectory);
  const stateKey = JSON.stringify(state);
  return decisionOrClassic(async () => {
    const port = judgmentPort(READ_SECRETS_SITE);
    const seenByPort = SEEN.get(port) ?? new Map<string, boolean>();
    SEEN.set(port, seenByPort);
    // One settings-driven port stays installed while its model setting changes, so the model is part of the key.
    const key = `${port.model}\0${stateKey}`;
    const seen = seenByPort.get(key);
    if (seen !== undefined) return seen;
    const run = await executePolicyCheck(
      () => sideEffect.runSome(port, state, ['secrets'], { site: READ_SECRETS_SITE, ...(signal === undefined ? {} : { signal }) }),
      signal,
    );
    signal?.throwIfAborted();
    // An absent reading cannot establish that no secret is touched, as with no decision model; it is not remembered.
    if (run.readings.secrets === undefined) return true;
    const touches = run.readings.secrets.verdict !== 'no';
    run.recordAction(touches ? 'secrets' : 'no-secrets');
    seenByPort.set(key, touches);
    if (seenByPort.size > SEEN_LIMIT) seenByPort.delete(seenByPort.keys().next().value!);
    return touches;
  }, () => {
    signal?.throwIfAborted();
    // This boolean requests the secret-aware permission path. Classic cannot
    // establish absence of secrets and never reuses a cached semantic no.
    return true;
  });
}

/** Forgets every remembered reading. */
export function forgetReadSecrets(): void {
  SEEN = new WeakMap();
}

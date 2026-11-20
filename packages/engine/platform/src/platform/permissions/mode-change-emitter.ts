/**
 * Publishes changes of the execution mode in force, the same one the gate
 * enforces: legacy auto-approve transitions and a decision model turning ready
 * or not ready under jev-decides included, a set model that stops or starts
 * answering among them.
 */

import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { EmitterContext } from '../runtime/emitters/index.js';
import { emitPresetChanged } from '../runtime/emitters/gate.js';
import { effectivePermissionMode } from '../gate/presets.js';
import { DECISION_MODEL_READINESS_KEYS, permissionDecisionModelReady } from './decision-model-readiness.js';
import { onDecisionModelEpisode } from '../runtime/decision-policy.js';

type ModeSource = Pick<ConfigManager, 'get' | 'subscribe'> & Partial<Pick<ConfigManager, 'isExplicitlySet'>>;

interface Binding { holders: number; readonly release: () => void }

/**
 * One subscription per config manager, bus and session id. A daemon composes
 * services for every hosted workspace against its one config manager and bus;
 * each composition binds again, and without this every mode change would be
 * published once per composition ever built.
 */
const bindings = new WeakMap<ModeSource, WeakMap<RuntimeEventBus, Map<string, Binding>>>();

function subscribe(configManager: ModeSource, runtimeBus: RuntimeEventBus, sessionId: string): () => void {
  // The mode the gate enforces: jev-decides without a ready decision model is
  // ask-me, so a decision model turning ready or not is a mode change too.
  const current = () => effectivePermissionMode(
    configManager.get('permissions.mode'),
    configManager.get('behavior.autoApprove'),
    permissionDecisionModelReady(configManager),
  );
  let previous = current();
  const publish = () => {
    const mode = current();
    if (mode === previous) return;
    const previousMode = previous;
    previous = mode;
    const ctx: EmitterContext = {
      sessionId,
      traceId: randomUUID(),
      source: 'gate-preset',
    };
    emitPresetChanged(runtimeBus, ctx, {
      mode,
      previousMode,
      preset: mode,
      previousPreset: previousMode,
    });
  };
  const unsubscribers = [
    configManager.subscribe('permissions.mode', publish),
    configManager.subscribe('behavior.autoApprove', publish),
    ...DECISION_MODEL_READINESS_KEYS.map((key) => configManager.subscribe(key, publish)),
    // A set model counts as working only while it answers: its first failure turns jev-decides
    // into ask-me and its next answer turns it back. Told once per episode; costs nothing while it answers.
    onDecisionModelEpisode(publish),
  ];
  return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
}

/**
 * Publish `PRESET_CHANGED` on each real transition of the effective
 * execution mode. Binding the same config manager, bus and session id again
 * shares the existing subscription; the returned function releases this
 * holder, and the subscription ends when the last holder releases it.
 *
 * @param sessionId, session/runtime id stamped on the emitted event.
 */
export function bindPermissionModeChangeEvent(
  configManager: ModeSource,
  runtimeBus: RuntimeEventBus,
  sessionId: string,
): () => void {
  let perBus = bindings.get(configManager);
  if (!perBus) bindings.set(configManager, perBus = new WeakMap());
  let perSession = perBus.get(runtimeBus);
  if (!perSession) perBus.set(runtimeBus, perSession = new Map());
  const sessions = perSession;
  let binding = sessions.get(sessionId);
  if (!binding) sessions.set(sessionId, binding = { holders: 0, release: subscribe(configManager, runtimeBus, sessionId) });
  const held = binding;
  held.holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.holders -= 1;
    if (held.holders > 0) return;
    held.release();
    if (sessions.get(sessionId) === held) sessions.delete(sessionId);
  };
}

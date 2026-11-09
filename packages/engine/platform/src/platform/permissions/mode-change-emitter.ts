/** Publishes effective execution-mode changes, including legacy auto-approve transitions. */

import { randomUUID } from 'node:crypto';
import type { ConfigManager } from '../config/manager.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { EmitterContext } from '../runtime/emitters/index.js';
import { emitPresetChanged } from '../runtime/emitters/gate.js';
import { effectivePermissionMode } from '../gate/presets.js';

/**
 * Subscribe to `permissions.mode` config changes and emit `PRESET_CHANGED` on
 * each real transition. Returns an unsubscribe function.
 *
 * @param sessionId, session/runtime id stamped on the emitted event.
 */
export function bindPermissionModeChangeEvent(
  configManager: Pick<ConfigManager, 'get' | 'subscribe'>,
  runtimeBus: RuntimeEventBus,
  sessionId: string,
): () => void {
  const current = () => effectivePermissionMode(configManager.get('permissions.mode'), configManager.get('behavior.autoApprove'));
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
  const unsubMode = configManager.subscribe('permissions.mode', publish);
  const unsubAutoApprove = configManager.subscribe('behavior.autoApprove', publish);
  return () => { unsubMode(); unsubAutoApprove(); };
}

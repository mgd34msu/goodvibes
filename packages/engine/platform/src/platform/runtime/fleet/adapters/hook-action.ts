import type { HookActionDefinition } from '../../../tools/workflow/index.js';
import type { ProcessNode } from '../types.js';

/** What the hook action did last: refused or failed to start, ran and ended, or is still running. */
function hookActionActivity(def: HookActionDefinition): ProcessNode['currentActivity'] {
  const fire = def.lastFire;
  if (!fire) return undefined;
  const fires = def.fireCount ?? 0;
  const prefix = `fired ${fires} time${fires === 1 ? '' : 's'}; last`;
  if (!fire.executed) return { kind: 'phase', text: `${prefix} did not run: ${fire.error ?? 'not started'}`, at: fire.at };
  if (fire.exitCode === undefined) return { kind: 'phase', text: `${prefix} is running`, at: fire.at };
  const ended = fire.timedOut ? 'was killed at its 60 s limit'
    : fire.exitCode === null ? 'was stopped by a signal'
      : fire.exitCode === 0 ? 'succeeded' : `failed with exit code ${String(fire.exitCode)}`;
  return { kind: 'phase', text: `${prefix} ${ended}`, at: fire.at };
}

/**
 * A workflow-tool hook action → ProcessNode of kind 'hook-action'. Enabled
 * means armed ('idle'), disabled maps to 'paused' (NOT 'killed': the
 * definition still exists and HookActionManager.enable() can re-arm it), and
 * the activity line says what the last fire did. resumable mirrors the
 * inverse of pausable.
 */
export function adaptHookAction(def: HookActionDefinition, now: number = Date.now()): ProcessNode {
  const activity = hookActionActivity(def);
  const running = def.lastFire?.executed === true && def.lastFire.exitCode === undefined;
  return {
    id: def.id,
    kind: 'hook-action',
    parentId: undefined,
    label: `on ${def.event}${def.condition ? ` if ${def.condition}` : ''} → ${def.action} (this process only)`,
    task: def.action,
    state: running ? 'executing-tool' : def.enabled ? 'idle' : 'paused',
    ...(def.lastFire ? { startedAt: def.lastFire.at } : {}),
    elapsedMs: running && def.lastFire ? Math.max(0, now - def.lastFire.at) : 0,
    costUsd: null,
    costState: 'unpriced',
    ...(activity ? { currentActivity: activity } : {}),
    capabilities: { interruptible: false, killable: true, pausable: def.enabled, resumable: !def.enabled, steerable: false },
    raw: def,
  };
}

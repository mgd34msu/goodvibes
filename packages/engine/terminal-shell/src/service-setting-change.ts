import type { ConfigKey } from '@goodvibes/engine/platform/platform/config';
export interface ServiceSettingChange {
  readonly key: ConfigKey;
  readonly previousValue: unknown;
  readonly value: unknown;
}
export interface ServiceSettingResult<Action extends string> {
  readonly handled: boolean;
  readonly action?: Action | undefined;
  readonly message?: string | undefined;
  readonly error?: string | undefined;
}
/**
 * Classification performs no lifecycle operation; each product supplies its own authority.
 * `service.autostart` is not a settings-screen action: the daemon applies it
 * whenever its value changes, however it was set, so a screen leaves it alone.
 */
export function classifyServiceSettingChange(change: ServiceSettingChange): 'unrelated' | 'unchanged' | 'changed' {
  if (!String(change.key).startsWith('service.') || change.key === 'service.autostart') return 'unrelated';
  return change.previousValue === change.value ? 'unchanged' : 'changed';
}

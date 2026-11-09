import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
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
/** Classification performs no lifecycle operation; each product supplies its own authority. */
export function classifyServiceSettingChange(change: ServiceSettingChange): 'unrelated' | 'unchanged' | 'changed' {
  if (!String(change.key).startsWith('service.')) return 'unrelated';
  return change.previousValue === change.value ? 'unchanged' : 'changed';
}

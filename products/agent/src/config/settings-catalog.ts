import { isDeepStrictEqual } from 'node:util';
import { readExecutionMode } from '../permissions/execution-mode.ts';
import type { ConfigKey, ConfigManager, ConfigSetting } from '@goodvibes/engine/platform/platform/config';
import { isAgentHostSettingKey, type AgentHostSettingKey } from './host-settings.ts';

export type AgentHostSetting = Omit<ConfigSetting, 'key' | 'type' | 'default'> & {
  readonly kind: 'host';
  readonly key: AgentHostSettingKey;
  readonly type: 'boolean';
  readonly default: boolean;
};
export type AgentConfigSetting = (ConfigSetting & { readonly kind?: 'builtin' }) | AgentHostSetting;
export type AgentSettingKey = ConfigKey | AgentHostSetting['key'];
export type AgentHostReader = Partial<Pick<ConfigManager, 'getHostSettingsSchema' | 'getHostBooleanSetting'>>;
export type AgentSettingsCatalog = Pick<ConfigManager, 'getSchema'> & AgentHostReader & Partial<Pick<ConfigManager, 'defaultOf'>>;

/**
 * Keep platform builtin rows and the Agent's registered host rows honestly
 * typed. A builtin row's default is the Agent's own (`defaultOf`), which the
 * Agent may set over the schema's, so "default" and "reset to" mean the value
 * a reset brings back.
 */
export function getAgentSettingsSchema(config: AgentSettingsCatalog): AgentConfigSetting[] {
  const defaultOf = config.defaultOf?.bind(config);
  const builtin = config.getSchema().map((setting) => {
    if (!defaultOf) return setting;
    const productDefault = defaultOf(setting.key);
    return isDeepStrictEqual(productDefault, setting.default) ? setting : { ...setting, default: productDefault };
  });
  const hosts: AgentHostSetting[] = [];
  for (const setting of config.getHostSettingsSchema?.() ?? []) {
    const key = setting.key;
    if (setting.type === 'boolean' && isAgentHostSettingKey(key)) hosts.push({ ...setting, kind: 'host', key });
  }
  return [...builtin, ...hosts];
}

export function readAgentSettingValue(config: Pick<ConfigManager, 'get' | 'getHostBooleanSetting'>, setting: AgentConfigSetting): unknown {
  if (setting.key === 'permissions.mode') return readExecutionMode(config);
  return setting.kind === 'host' ? config.getHostBooleanSetting(setting.key).get() : config.get(setting.key);
}

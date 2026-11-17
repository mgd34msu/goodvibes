import { installedDataWriter } from '../runtime/native-data-writer.ts';
import { ConfigManager, daemonConfigPathForHome, resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import { NOTIFICATIONS_METADATA_ONLY_KEY, NOTIFICATIONS_METADATA_ONLY_SETTING } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { AGENT_HOSTED_RESEARCH_SCREENING_KEY, AGENT_HOSTED_RESEARCH_SCREENING_SETTING } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

// The host key is validated and registered on each Agent instance before load.
// platform ConfigKey covers only GoodVibesConfig fields; Agent uses a validated host handle.
export const AGENT_NOTIFICATIONS_METADATA_ONLY_KEY = NOTIFICATIONS_METADATA_ONLY_KEY;
// The screening consent is read by the Agent and, for a turn it hosts for the Agent, by the daemon: one definition.
export { AGENT_HOSTED_RESEARCH_SCREENING_KEY };
export type AgentHostSettingKey = typeof AGENT_NOTIFICATIONS_METADATA_ONLY_KEY | typeof AGENT_HOSTED_RESEARCH_SCREENING_KEY;
export function isAgentHostSettingKey(key: string): key is AgentHostSettingKey {
  return key === AGENT_NOTIFICATIONS_METADATA_ONLY_KEY || key === AGENT_HOSTED_RESEARCH_SCREENING_KEY;
}

/** Narrow reader for the platform's notification privacy callback. */
export function readAgentHostSetting(config: Pick<ConfigManager, 'getHostBooleanSetting'>, key: string): boolean | undefined {
  return key === AGENT_NOTIFICATIONS_METADATA_ONLY_KEY ? config.getHostBooleanSetting(key).get() : undefined;
}


/** Agent construction opts into the public instance-owned platform host schema. */
export class AgentConfigManager extends ConfigManager {
  constructor(options: ConstructorParameters<typeof ConfigManager>[0]) {
    // The daemon reads the store under its own resolved home, which GOODVIBES_DAEMON_HOME can move;
    // a client left on the default path would save daemon-owned settings where the daemon never looks.
    const daemonTierPath = options.daemonTierPath ?? (options.homeDir ? daemonConfigPathForHome(resolveGoodVibesDaemonHome(options.homeDir)) : undefined);
    super({ ...options, daemonTierPath, nativeDataWriter: options.nativeDataWriter ?? installedDataWriter, hostSettings: [...(options.hostSettings ?? []), NOTIFICATIONS_METADATA_ONLY_SETTING, AGENT_HOSTED_RESEARCH_SCREENING_SETTING] });
  }
}

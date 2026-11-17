/**
 * Config schema defaults and runtime metadata for goodvibes-platform.
 */

import { coreConfigDefaults, coreHeadConfigSettings, coreTailConfigSettings } from './schema-domain-core.js';
import { runtimeConfigDefaults, runtimePrimaryConfigSettings, runtimeSecondaryConfigSettings } from './schema-domain-runtime.js';
import { conversationGateConfigDefaults, conversationGateConfigSettings } from './schema-domain-conversation-gate.js';
import { contractConfigDefaults, contractConfigSettings } from './schema-domain-contract.js';
import { judgmentConfigDefaults, judgmentConfigSettings } from './schema-domain-judgment.js';
import { hostedSessionsConfigDefaults, hostedSessionsConfigSettings } from './schema-domain-hosted-sessions.js';
import { atRestConfigDefaults, atRestConfigSettings } from './schema-domain-at-rest.js';
import { learningConfigDefaults, learningConfigSettings } from './schema-domain-learning.js';
import { powerConfigDefaults, powerConfigSettings } from './schema-domain-power.js';
import { memoryConfigDefaults, memoryConfigSettings } from './schema-domain-memory.js';
import { ownerProfileConfigDefaults, ownerProfileConfigSettings } from './schema-domain-owner-profile.js';
import { occasionsConfigDefaults, occasionsConfigSettings } from './schema-domain-occasions.js';
import { voiceLocalConfigDefaults, voiceLocalConfigSettings } from './schema-domain-voice-local.js';
import { voiceWakeConfigDefaults, voiceWakeConfigSettings } from './schema-domain-voice-wake.js';
import { triggersConfigDefaults, triggersConfigSettings } from './schema-domain-triggers.js';
import { deviceConfigDefaults, deviceConfigSettings } from './schema-domain-device.js';
import { pushConfigDefaults, pushConfigSettings } from './schema-domain-push.js';
import { fleetConfigDefaults, fleetConfigSettings } from './schema-domain-fleet.js';
import { clusterConfigDefaults, clusterConfigSettings } from './schema-domain-cluster.js';
import { connectorConfigDefaults, connectorConfigSettings } from './schema-domain-connectors.js';
import { surfaceConfigDefaults, surfaceConfigSettings } from './schema-domain-surfaces.js';
import { featureConfigDefaults, featureConfigSettings } from './schema-domain-features.js';
import { featureControlSettings } from './schema-domain-feature-controls.js';
import { updateConfigDefaults, updateConfigSettings } from './schema-domain-update.js';
import { checkpointsConfigDefaults, checkpointsConfigSettings } from './schema-domain-checkpoints.js';
import { pricingConfigDefaults, pricingConfigSettings } from './schema-domain-pricing.js';
import { paymentsConfigDefaults, paymentsConfigSettings } from './schema-domain-payments.js';
import { daemonLocationConfigSettings } from './schema-domain-daemon-location.js';
import { listConfigSettings } from './schema-domain-lists.js';
import type { ConfigKey, ConfigSetting, GoodVibesConfig, SurfacesConfig } from './schema-types.js';

export * from './schema-types.js';

export const DEFAULT_CONFIG = {
  display: coreConfigDefaults.display,
  provider: coreConfigDefaults.provider,
  behavior: coreConfigDefaults.behavior,
  storage: coreConfigDefaults.storage,
  permissions: coreConfigDefaults.permissions,
  diagnostics: coreConfigDefaults.diagnostics,
  orchestration: coreConfigDefaults.orchestration,
  planner: coreConfigDefaults.planner,
  sandbox: coreConfigDefaults.sandbox,
  ui: coreConfigDefaults.ui,
  tts: coreConfigDefaults.tts,
  automation: runtimeConfigDefaults.automation,
  checkin: runtimeConfigDefaults.checkin,
  controlPlane: runtimeConfigDefaults.controlPlane,
  httpListener: runtimeConfigDefaults.httpListener,
  web: runtimeConfigDefaults.web,
  surfaces: surfaceConfigDefaults as SurfacesConfig,
  watchers: { ...runtimeConfigDefaults.watchers, ...triggersConfigDefaults },
  service: runtimeConfigDefaults.service,
  update: updateConfigDefaults.update,
  checkpoints: checkpointsConfigDefaults.checkpoints,
  network: runtimeConfigDefaults.network,
  relay: runtimeConfigDefaults.relay,
  runtime: runtimeConfigDefaults.runtime,
  conversationGate: conversationGateConfigDefaults.conversationGate,
  hostedSessions: hostedSessionsConfigDefaults.hostedSessions,
  telemetry: runtimeConfigDefaults.telemetry,
  atRest: atRestConfigDefaults.atRest,
  worktree: runtimeConfigDefaults.worktree,
  learning: learningConfigDefaults.learning,
  power: powerConfigDefaults.power,
  memory: memoryConfigDefaults.memory,
  profile: ownerProfileConfigDefaults.profile,
  occasions: occasionsConfigDefaults.occasions,
  voice: { ...voiceLocalConfigDefaults.voice, ...voiceWakeConfigDefaults.voice },
  device: deviceConfigDefaults.device,
  push: pushConfigDefaults.push,
  fleet: fleetConfigDefaults.fleet,
  cluster: clusterConfigDefaults.cluster,
  batch: runtimeConfigDefaults.batch,
  cloudflare: runtimeConfigDefaults.cloudflare,
  daemon: coreConfigDefaults.daemon,
  danger: coreConfigDefaults.danger,
  tools: coreConfigDefaults.tools,
  contract: contractConfigDefaults.contract,
  judgment: judgmentConfigDefaults.judgment,
  cache: coreConfigDefaults.cache,
  helper: coreConfigDefaults.helper,
  notifications: coreConfigDefaults.notifications,
  fetch: featureConfigDefaults.fetch,
  security: featureConfigDefaults.security,
  integrations: featureConfigDefaults.integrations,
  policy: featureConfigDefaults.policy,
  agents: featureConfigDefaults.agents,
  pricing: pricingConfigDefaults.pricing,
  payments: paymentsConfigDefaults.payments,
  calendar: connectorConfigDefaults.calendar,
  google: connectorConfigDefaults.google,
} as GoodVibesConfig;

export const CONFIG_SCHEMA: ConfigSetting[] = [
  ...coreHeadConfigSettings,
  ...runtimePrimaryConfigSettings,
  ...conversationGateConfigSettings,
  ...hostedSessionsConfigSettings,
  ...atRestConfigSettings,
  ...paymentsConfigSettings,
  ...daemonLocationConfigSettings,
  ...learningConfigSettings,
  ...powerConfigSettings,
  ...memoryConfigSettings,
  ...ownerProfileConfigSettings,
  ...occasionsConfigSettings,
  ...voiceLocalConfigSettings,
  ...voiceWakeConfigSettings,
  ...deviceConfigSettings,
  ...pushConfigSettings,
  ...fleetConfigSettings,
  ...clusterConfigSettings,
  ...surfaceConfigSettings,
  ...runtimeSecondaryConfigSettings,
  ...triggersConfigSettings,
  ...updateConfigSettings,
  ...checkpointsConfigSettings,
  ...coreTailConfigSettings,
  ...contractConfigSettings,
  ...judgmentConfigSettings,
  ...featureConfigSettings,
  ...featureControlSettings,
  ...pricingConfigSettings,
  ...connectorConfigSettings,
  ...listConfigSettings,
] as ConfigSetting[];

/** Set of all valid config keys for runtime validation. */
export const CONFIG_KEYS = new Set<string>(CONFIG_SCHEMA.map((setting) => setting.key));

/** Type guard: returns true if key is a valid ConfigKey. */
export function isValidConfigKey(key: string): key is ConfigKey {
  return CONFIG_KEYS.has(key);
}

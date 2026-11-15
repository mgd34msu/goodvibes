import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import {
  GOODVIBES_NTFY_AGENT_TOPIC,
  GOODVIBES_NTFY_CHAT_TOPIC,
  GOODVIBES_NTFY_REMOTE_TOPIC,
  resolveGoodVibesNtfyTopics,
} from '@goodvibes-jev/engine/platform/platform/integrations';
import { enableFeatureFlags, getMissingSurfaceFeatureFlags, getServerSurfaceFeatureFlags, surfaceFeatureGateSettingsKeys } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { formatRuntimeEndpointBinding, resolveRuntimeEndpointBinding } from '@goodvibes-jev/engine/terminal-shell';
import { classifyBindPosture, isNetworkFacing } from './network-posture.ts';
import type { CliCommandRuntime, RuntimeEndpointId } from '@goodvibes-jev/engine/terminal-shell';
import {
  applyTargetEndpointFlagsOrDefault,
  enableEndpointLanDefault,
  enableServicePosture,
  formatJsonOrText,
  isPresentConfigValue,
  probeTcp,
  readAuthPaths,
  yesNo,
} from './management-utils.ts';

export const SURFACE_CONFIGS = [
  ['slack', 'Slack', ['surfaces.slack.signingSecret', 'surfaces.slack.botToken']],
  ['discord', 'Discord', ['surfaces.discord.publicKey', 'surfaces.discord.botToken', 'surfaces.discord.applicationId']],
  ['telegram', 'Telegram', ['surfaces.telegram.botToken']],
  ['webhook', 'Webhook', ['surfaces.webhook.secret']],
  ['ntfy', 'ntfy', ['surfaces.ntfy.baseUrl']],
  ['googleChat', 'Google Chat', ['surfaces.googleChat.webhookUrl']],
  ['signal', 'Signal', ['surfaces.signal.bridgeUrl', 'surfaces.signal.account']],
  ['whatsapp', 'WhatsApp', ['surfaces.whatsapp.accessToken', 'surfaces.whatsapp.phoneNumberId']],
  ['imessage', 'iMessage', ['surfaces.imessage.bridgeUrl', 'surfaces.imessage.account']],
  ['msteams', 'Microsoft Teams', ['surfaces.msteams.appId', 'surfaces.msteams.appPassword']],
  ['bluebubbles', 'BlueBubbles', ['surfaces.bluebubbles.serverUrl', 'surfaces.bluebubbles.password']],
  ['mattermost', 'Mattermost', ['surfaces.mattermost.baseUrl', 'surfaces.mattermost.botToken']],
  ['matrix', 'Matrix', ['surfaces.matrix.homeserverUrl', 'surfaces.matrix.accessToken', 'surfaces.matrix.userId']],
] as const;

const ENDPOINT_LABELS: Readonly<Record<RuntimeEndpointId, string>> = {
  controlPlane: 'control-plane',
  web: 'web',
  httpListener: 'http-listener',
};

/** Every key an enable can write, so a refused flag can put them all back. */
const SURFACE_ENABLE_KEYS: readonly string[] = [
  ...(['web', 'controlPlane', 'httpListener'] as const).flatMap((endpoint) => [`${endpoint}.hostMode`, `${endpoint}.host`, `${endpoint}.port`]),
];

function snapshotConfig(config: ConfigManager, keys: readonly string[]): ReadonlyMap<string, unknown> {
  return new Map(keys.map((key) => [key, config.get(key as ConfigKey)]));
}

function restoreConfig(config: ConfigManager, snapshot: ReadonlyMap<string, unknown>): void {
  for (const [key, value] of snapshot) {
    if (value !== undefined) config.setDynamic(key as ConfigKey, value);
  }
}

export async function handleSurfacesCommand(runtime: CliCommandRuntime): Promise<{ readonly output: string; readonly exitCode: number }> {
  const config = runtime.configManager;
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  const target = rest[0];
  if (sub === 'enable' || sub === 'disable') {
    if (!target) return { output: `Usage: goodvibes surfaces ${sub} <web|listener|control-plane|surfaceId>`, exitCode: 2 };
    const enabled = sub === 'enable';
    // A refused flag leaves nothing half-applied: the endpoint step runs before the enable
    // writes, and whatever it set before failing is put back.
    const before = snapshotConfig(config, SURFACE_ENABLE_KEYS);
    const refuse = (message: string): { readonly output: string; readonly exitCode: number } => {
      restoreConfig(config, before);
      return { output: message, exitCode: 2 };
    };
    /** Endpoints this command moved off their previous binding, for the success line. */
    const reached: RuntimeEndpointId[] = [];
    if (target === 'web') {
      if (enabled) {
        const webError = applyTargetEndpointFlagsOrDefault(runtime, 'web');
        if (webError) return refuse(webError);
        reached.push('web');
        const webBinding = resolveRuntimeEndpointBinding(config, 'web');
        if (runtime.cli.flags.hostname !== undefined && webBinding.hostMode === 'local') {
          config.setDynamic('controlPlane.hostMode', 'local');
          config.setDynamic('controlPlane.host', '127.0.0.1');
        } else {
          enableEndpointLanDefault(config, 'controlPlane');
        }
        reached.push('controlPlane');
        enableFeatureFlags(config, getServerSurfaceFeatureFlags({ serverBacked: true, web: true }));
        config.setDynamic('daemon.enabled', true);
        config.setDynamic('controlPlane.enabled', true);
      }
      config.setDynamic('web.enabled', enabled);
    }
    else if (target === 'listener' || target === 'http-listener') {
      if (enabled) {
        const listenerError = applyTargetEndpointFlagsOrDefault(runtime, 'httpListener');
        if (listenerError) return refuse(listenerError);
        reached.push('httpListener');
      }
      config.setDynamic('danger.httpListener', enabled);
    }
    else if (target === 'control-plane' || target === 'controlPlane') {
      if (enabled) {
        const controlPlaneError = applyTargetEndpointFlagsOrDefault(runtime, 'controlPlane');
        if (controlPlaneError) return refuse(controlPlaneError);
        reached.push('controlPlane');
      }
      config.setDynamic('controlPlane.enabled', enabled);
      config.setDynamic('daemon.enabled', enabled);
    }
    else if (SURFACE_CONFIGS.some(([id]) => id === target)) {
      if (enabled) {
        // An external surface receives its traffic on the HTTP listener, so enabling one opens that listener.
        const listenerError = applyTargetEndpointFlagsOrDefault(runtime, 'httpListener');
        if (listenerError) return refuse(listenerError);
        reached.push('httpListener');
        enableFeatureFlags(config, getServerSurfaceFeatureFlags({ serverBacked: true, externalSurfaces: [target] }));
        config.setDynamic('danger.httpListener', true);
      }
      config.setDynamic(`surfaces.${target}.enabled` as ConfigKey, enabled);
    }
    else return { output: `Unknown surface: ${target}`, exitCode: 1 };
    if (enabled) {
      enableServicePosture(config);
    }
    const lines = [`Surface ${enabled ? 'enabled' : 'disabled'}: ${target}`];
    if (enabled) {
      for (const endpoint of reached) {
        const binding = resolveRuntimeEndpointBinding(config, endpoint);
        const posture = classifyBindPosture(binding);
        lines.push(`  ${ENDPOINT_LABELS[endpoint]}: ${formatRuntimeEndpointBinding(binding)} (${posture.label})`);
        if (posture.networkFacing) {
          lines.push(`  ${ENDPOINT_LABELS[endpoint]} is reachable from other machines on the network. Pass --hostname 127.0.0.1 to keep it on this machine.`);
        }
      }
    } else {
      lines.push('  Its network settings are left as they are; run `goodvibes surfaces list` to see them.');
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }
  if (sub !== 'list' && sub !== 'status' && sub !== 'check' && sub !== 'show') {
    return { output: 'Usage: goodvibes surfaces [list|check|show <surfaceId>|enable <surfaceId>|disable <surfaceId>]', exitCode: 2 };
  }
  const controlPlane = resolveRuntimeEndpointBinding(config, 'controlPlane');
  const web = resolveRuntimeEndpointBinding(config, 'web');
  const httpListener = resolveRuntimeEndpointBinding(config, 'httpListener');
  const includeProbe = sub === 'check';
  const targetExternalSurface = target && SURFACE_CONFIGS.some(([id]) => id === target);
  const shouldProbeControlPlane = includeProbe && !target;
  const shouldProbeListener = includeProbe && (!target || targetExternalSurface);
  // Nothing listens on web.host:web.port; the control-plane listener serves the web bundle, so it is the one probed.
  const [controlPlaneReachable, listenerReachable] = includeProbe
    ? await Promise.all([
      shouldProbeControlPlane && controlPlane.recognized ? probeTcp(controlPlane.host, controlPlane.port) : Promise.resolve(undefined),
      shouldProbeListener && httpListener.recognized ? probeTcp(httpListener.host, httpListener.port) : Promise.resolve(undefined),
    ])
    : [undefined, undefined];
  const webReachable = web.recognized ? controlPlaneReachable : undefined;
  const externalSurfaces = SURFACE_CONFIGS.map(([id, label, requiredKeys]) => {
    const enabled = config.get(`surfaces.${id}.enabled` as ConfigKey);
    const missing = requiredKeys.filter((key) => !isPresentConfigValue(config.get(key as ConfigKey)));
    const missingFeatureFlags = enabled === true ? getMissingSurfaceFeatureFlags(config, id) : [];
    return {
      id,
      label,
      enabled,
      ready: !enabled || (missing.length === 0 && missingFeatureFlags.length === 0),
      missing,
      missingFeatureFlags,
    };
  });
  const filteredSurfaces = target ? externalSurfaces.filter((surface) => surface.id === target) : externalSurfaces;
  if (target && filteredSurfaces.length === 0) return { output: `Unknown surface: ${target}`, exitCode: 1 };
  const ntfyTopics = resolveGoodVibesNtfyTopics({
    chatTopic: String(config.get('surfaces.ntfy.chatTopic' as ConfigKey) || GOODVIBES_NTFY_CHAT_TOPIC),
    agentTopic: String(config.get('surfaces.ntfy.agentTopic' as ConfigKey) || GOODVIBES_NTFY_AGENT_TOPIC),
    remoteTopic: String(config.get('surfaces.ntfy.remoteTopic' as ConfigKey) || GOODVIBES_NTFY_REMOTE_TOPIC),
  });
  const readinessIssues: string[] = [];
  for (const [endpointLabel, endpointBinding] of [['controlPlane', controlPlane], ['web', web], ['httpListener', httpListener]] as const) {
    if (!endpointBinding.recognized) {
      readinessIssues.push(`${endpointLabel}.hostMode '${endpointBinding.hostMode}' is not a recognized mode (local|network|custom); the daemon cannot bind this endpoint until it is corrected.`);
    }
  }
  if (shouldProbeControlPlane && controlPlane.recognized && config.get('controlPlane.enabled') === true && !controlPlaneReachable) {
    readinessIssues.push(`Control plane is enabled but not reachable on ${controlPlane.host}:${controlPlane.port}.`);
  }
  if (shouldProbeListener && httpListener.recognized && config.get('danger.httpListener') === true && !listenerReachable) {
    readinessIssues.push(`HTTP listener is enabled but not reachable on ${httpListener.host}:${httpListener.port}.`);
  }
  for (const surface of filteredSurfaces) {
    if (surface.enabled !== true) continue;
    if (config.get('danger.httpListener') !== true) {
      readinessIssues.push(`${surface.label} is enabled but the HTTP listener is disabled.`);
    }
    if (surface.missing.length > 0) {
      readinessIssues.push(`${surface.label} is enabled but missing ${surface.missing.join(', ')}.`);
    }
    if (surface.missingFeatureFlags.length > 0) {
      readinessIssues.push(`${surface.label} is enabled but these settings are off: ${surfaceFeatureGateSettingsKeys(surface.missingFeatureFlags).join(', ')}.`);
    }
  }
  const value = {
    controlPlane: {
      enabled: config.get('controlPlane.enabled'),
      hostMode: controlPlane.hostMode,
      configuredHost: controlPlane.configuredHost,
      host: controlPlane.host,
      port: controlPlane.port,
      recognized: controlPlane.recognized,
      reachable: controlPlaneReachable,
    },
    web: {
      enabled: config.get('web.enabled'),
      hostMode: web.hostMode,
      configuredHost: web.configuredHost,
      host: web.host,
      port: web.port,
      recognized: web.recognized,
      reachable: webReachable,
    },
    httpListener: {
      enabled: config.get('danger.httpListener'),
      hostMode: httpListener.hostMode,
      configuredHost: httpListener.configuredHost,
      host: httpListener.host,
      port: httpListener.port,
      recognized: httpListener.recognized,
      reachable: listenerReachable,
    },
    surfaces: filteredSurfaces,
    readinessIssues,
  };
  const output = formatJsonOrText(runtime.cli)(value, [
    'GoodVibes surfaces',
    `  control-plane: ${yesNo(value.controlPlane.enabled)} (${formatRuntimeEndpointBinding(value.controlPlane)})${includeProbe && value.controlPlane.reachable !== undefined ? ` reachable=${yesNo(value.controlPlane.reachable)}` : ''}`,
    `  web: ${yesNo(value.web.enabled)} (${formatRuntimeEndpointBinding(value.web)})${includeProbe && value.web.reachable !== undefined ? ` reachable=${yesNo(value.web.reachable)}` : ''}`,
    `  http-listener: ${yesNo(value.httpListener.enabled)} (${formatRuntimeEndpointBinding(value.httpListener)})${includeProbe && value.httpListener.reachable !== undefined ? ` reachable=${yesNo(value.httpListener.reachable)}` : ''}`,
    '',
    'External surfaces:',
    ...value.surfaces.map((surface) => `  ${surface.label.padEnd(16)} enabled=${yesNo(surface.enabled)} ready=${yesNo(surface.ready)}${surface.enabled && surface.missing.length > 0 ? ` missing=${surface.missing.join(',')}` : ''}${surface.enabled && surface.missingFeatureFlags.length > 0 ? ` settingsOff=${surfaceFeatureGateSettingsKeys(surface.missingFeatureFlags).join(',')}` : ''}`),
    ...(filteredSurfaces.some((surface) => surface.id === 'ntfy') ? [
      '',
      'ntfy inbound topics:',
      `  chat: ${ntfyTopics.chatTopic}`,
      `  agent: ${ntfyTopics.agentTopic}`,
      `  daemon-only remote: ${ntfyTopics.remoteTopic}`,
      `  default delivery topic: ${String(config.get('surfaces.ntfy.topic') || '(none)')}`,
    ] : []),
    ...(includeProbe ? [
      readinessIssues.length === 0 ? 'Readiness: ready' : 'Readiness: needs attention',
      ...readinessIssues.map((issue) => `  - ${issue}`),
    ] : []),
  ].join('\n'));
  return { output, exitCode: includeProbe && readinessIssues.length > 0 ? 1 : 0 };
}

export interface ListenerTestResult {
  readonly enabled: unknown;
  readonly hostMode: string;
  readonly configuredHost: string;
  readonly host: string;
  readonly port: number;
  readonly recognized: boolean;
  readonly posture: ReturnType<typeof classifyBindPosture>;
  /** undefined = NOT PROBED (unrecognized host mode), a tri-state, never coerced to false. */
  readonly reachable: boolean | undefined;
  readonly service: {
    readonly enabled: unknown;
    readonly autostart: unknown;
    readonly restartOnFailure: unknown;
  };
  readonly auth: ReturnType<typeof readAuthPaths>;
  readonly surfaces: readonly {
    readonly id: string;
    readonly label: string;
    readonly enabled: unknown;
    readonly ready: boolean;
    readonly missing: readonly string[];
    readonly missingFeatureFlags: readonly string[];
  }[];
  readonly issues: readonly string[];
}

export async function buildListenerTestResult(runtime: CliCommandRuntime): Promise<ListenerTestResult> {
  const enabled = runtime.configManager.get('danger.httpListener');
  const binding = resolveRuntimeEndpointBinding(runtime.configManager, 'httpListener');
  const posture = classifyBindPosture(binding);
  // Not-probed (unrecognized host mode) stays undefined, never a definite false.
  const reachable = enabled === true
    ? (binding.recognized ? await probeTcp(binding.host, binding.port) : undefined)
    : false;
  const auth = readAuthPaths(runtime);
  const service = {
    enabled: runtime.configManager.get('service.enabled'),
    autostart: runtime.configManager.get('service.autostart'),
    restartOnFailure: runtime.configManager.get('service.restartOnFailure'),
  };
  const surfaces = SURFACE_CONFIGS.map(([id, label, requiredKeys]) => {
    const surfaceEnabled = runtime.configManager.get(`surfaces.${id}.enabled` as ConfigKey);
    const missing = requiredKeys.filter((key) => !isPresentConfigValue(runtime.configManager.get(key as ConfigKey)));
    const missingFeatureFlags = surfaceEnabled === true ? getMissingSurfaceFeatureFlags(runtime.configManager, id) : [];
    return {
      id,
      label,
      enabled: surfaceEnabled,
      ready: surfaceEnabled !== true || (missing.length === 0 && missingFeatureFlags.length === 0),
      missing,
      missingFeatureFlags,
    };
  }).filter((surface) => surface.enabled === true);
  const issues: string[] = [];
  if (!binding.recognized) issues.push(`httpListener.hostMode '${binding.hostMode}' is not a recognized mode (local|network|custom); the daemon cannot bind until it is corrected.`);
  if (enabled !== true) issues.push('HTTP listener is disabled.');
  if (enabled === true && service.enabled !== true) issues.push('HTTP listener is enabled but service mode is off.');
  if (enabled === true && service.autostart !== true) issues.push('HTTP listener is enabled but service autostart is off.');
  if (enabled === true && service.restartOnFailure !== true) issues.push('HTTP listener is enabled but service restart-on-failure is off.');
  if (isNetworkFacing(enabled, binding) && !auth.userStorePresent) issues.push('Network-facing listener has no local auth user store.');
  if (isNetworkFacing(enabled, binding) && auth.bootstrapCredentialPresent) issues.push('Network-facing listener still has a bootstrap credential file.');
  for (const surface of surfaces) {
    if (surface.missing.length > 0) issues.push(`${surface.label} is enabled but missing ${surface.missing.join(', ')}.`);
    if (surface.missingFeatureFlags.length > 0) issues.push(`${surface.label} is enabled but these settings are off: ${surfaceFeatureGateSettingsKeys(surface.missingFeatureFlags).join(', ')}.`);
  }
  return { enabled, ...binding, posture, reachable, service, auth, surfaces, issues };
}

export function formatListenerTestResult(runtime: CliCommandRuntime, value: ListenerTestResult): string {
  return formatJsonOrText(runtime.cli)(value, [
    'GoodVibes listener test',
    `  enabled: ${yesNo(value.enabled)}`,
    `  endpoint: ${formatRuntimeEndpointBinding(value)}`,
    `  bind posture: ${value.recognized ? value.posture.label : 'unknown (unrecognized host mode)'}`,
    `  reachable: ${value.reachable === undefined ? 'not probed (unrecognized host mode)' : yesNo(value.reachable)}`,
    `  service: enabled=${yesNo(value.service.enabled)} autostart=${yesNo(value.service.autostart)} restartOnFailure=${yesNo(value.service.restartOnFailure)}`,
    `  local auth users: ${value.auth.userStorePresent ? 'present' : 'missing'}`,
    `  bootstrap credential: ${value.auth.bootstrapCredentialPresent ? 'present' : 'missing'}`,
    value.surfaces.length === 0 ? '  enabled webhook surfaces: none' : '  enabled webhook surfaces:',
    ...value.surfaces.map((surface) => `    ${surface.label}: ready=${yesNo(surface.ready)}${surface.missing.length > 0 ? ` missing=${surface.missing.join(',')}` : ''}${surface.missingFeatureFlags.length > 0 ? ` settingsOff=${surfaceFeatureGateSettingsKeys(surface.missingFeatureFlags).join(',')}` : ''}`),
    value.issues.length === 0 ? '  readiness: ready' : '  readiness: needs attention',
    ...value.issues.map((issue) => `    - ${issue}`),
  ].join('\n'));
}

import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef, createRuntimeSecretsManager, resolveDaemonEnabled, resolveGoodVibesDaemonHome, resolveSecretInput } from '@goodvibes-jev/engine/platform/platform/config';
import { ensureNtfyTopics, resolveGoodVibesNtfyTopics } from '@goodvibes-jev/engine/platform/platform/integrations';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { enableFeatureFlags, getMissingSurfaceFeatureFlags, getServerSurfaceFeatureFlags, surfaceFeatureGateSettingsKeys } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { formatRuntimeEndpointBinding, resolveRuntimeEndpointBinding } from '@goodvibes-jev/engine/terminal-shell';
import { classifyBindPosture, isNetworkFacing } from '@goodvibes-jev/engine/terminal-shell';
import type { CliCommandRuntime, RuntimeEndpointId } from '@goodvibes-jev/engine/terminal-shell';
import {
  applyTargetEndpointFlagsOrDefault,
  enableEndpointLanDefault,
  enableServicePosture,
  formatJsonOrText,
  isPresentConfigValue,
  probeTcp,
  readAuthPaths,
  withDaemonSettingsRoute,
  yesNo,
} from './management-utils.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

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

/** The endpoint names every verb accepts, mapped to the endpoint they mean. */
const ENDPOINT_TARGETS: Readonly<Record<string, RuntimeEndpointId>> = {
  web: 'web',
  listener: 'httpListener',
  'http-listener': 'httpListener',
  'control-plane': 'controlPlane',
  controlPlane: 'controlPlane',
};

type SurfaceTarget =
  | { readonly kind: 'endpoint'; readonly endpoint: RuntimeEndpointId }
  | { readonly kind: 'external'; readonly id: (typeof SURFACE_CONFIGS)[number][0] };

/** One target table for list, show, check, enable and disable. */
function resolveSurfaceTarget(target: string): SurfaceTarget | undefined {
  const endpoint = ENDPOINT_TARGETS[target];
  if (endpoint) return { kind: 'endpoint', endpoint };
  const external = SURFACE_CONFIGS.find(([id]) => id === target);
  return external ? { kind: 'external', id: external[0] } : undefined;
}

function unknownSurface(target: string): { readonly output: string; readonly exitCode: number } {
  const valid = ['web', 'listener', 'control-plane', ...SURFACE_CONFIGS.map(([id]) => id)];
  return { output: `Unknown surface: ${target}. Valid surfaces: ${valid.join(', ')}.`, exitCode: 2 };
}

function missingSurfaceKeys(config: ConfigManager, id: string): string[] {
  const requiredKeys = SURFACE_CONFIGS.find(([surfaceId]) => surfaceId === id)?.[2] ?? [];
  return requiredKeys.filter((key) => !isPresentConfigValue(config.get(key as ConfigKey)));
}

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

/**
 * After a channel is switched off: what enabling channels turned on and is
 * still on, and why. The HTTP listener is the channels' inbound door, so with
 * none left it is named with the command that closes it; the shared
 * capabilities stay on for whatever else uses them.
 */
function sharedSettingsLeftOn(config: ConfigManager, surfaceId: string): string[] {
  const stillEnabled = SURFACE_CONFIGS.filter(([id]) => config.get(`surfaces.${id}.enabled` as ConfigKey) === true).map(([, label]) => label);
  const lines: string[] = [];
  if (config.get('danger.httpListener') === true) {
    lines.push(stillEnabled.length > 0
      ? `  The HTTP listener stays on: ${stillEnabled.join(', ')} still receive${stillEnabled.length === 1 ? 's' : ''} on it.`
      : '  The HTTP listener (danger.httpListener) is still on and no enabled channel uses it; run `goodvibes surfaces disable listener` to close it.');
  }
  // What enabling this channel switched on besides its own switch.
  const sharedOn = surfaceFeatureGateSettingsKeys(getServerSurfaceFeatureFlags({ serverBacked: true, externalSurfaces: [surfaceId] }))
    .filter((key) => !key.startsWith('surfaces.') && config.get(key as ConfigKey) === true);
  if (sharedOn.length > 0) {
    lines.push(`  Left on: ${sharedOn.join(', ')}; ${stillEnabled.length > 0 ? `${stillEnabled.join(', ')} and ` : ''}the web UI, terminals and automation deliveries use them.`);
  }
  return lines;
}

export async function handleSurfacesCommand(runtime: CliCommandRuntime): Promise<{ readonly output: string; readonly exitCode: number }> {
  const [sub = 'list'] = runtime.cli.commandArgs;
  if (sub !== 'enable' && sub !== 'disable') return await surfacesCommand(runtime);
  // A surface's settings are the daemon's: while it is reachable they are sent
  // to it, otherwise written to its file for it to read when it starts.
  const { result, refused } = await withDaemonSettingsRoute(runtime, () => surfacesCommand(runtime));
  if (refused.length === 0) return result;
  return {
    output: [result.output, ...refused.map(({ key, error }) => `The daemon refused ${key}; it was not changed: ${summarizeError(error)}`)].join('\n'),
    exitCode: 1,
  };
}

/**
 * The secret store this command reads and writes ntfy topic names in. A topic
 * name is a credential (declared secret-bearing), so it is kept in the daemon
 * tier and its setting holds a reference; this command is the owner's own, so
 * it shows the names he must subscribe to.
 */
function ntfyTopicSecrets(runtime: CliCommandRuntime) {
  return createRuntimeSecretsManager({
    projectRoot: runtime.workingDirectory,
    globalHome: runtime.homeDirectory,
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
    configManager: runtime.configManager,
    daemonHome: resolveGoodVibesDaemonHome(runtime.homeDirectory),
  });
}

/** A topic setting's name for the owner's screen: the stored name its reference names, or the setting as written. */
async function ntfyTopicName(runtime: CliCommandRuntime, secrets: ReturnType<typeof ntfyTopicSecrets>, key: string): Promise<string> {
  const value = runtime.configManager.get(key as ConfigKey);
  if (typeof value !== 'string' || value.trim() === '') return '';
  return (await resolveSecretInput(value, { resolveLocalSecret: (name) => secrets.get(name), homeDirectory: secrets.getGlobalHome() }, 'dispatch'))?.trim() ?? '';
}

async function surfacesCommand(runtime: CliCommandRuntime): Promise<{ readonly output: string; readonly exitCode: number }> {
  const config = runtime.configManager;
  const [sub = 'list', ...rest] = runtime.cli.commandArgs;
  const target = rest[0];
  if (sub === 'enable' || sub === 'disable') {
    if (!target) return { output: `Usage: goodvibes surfaces ${sub} <web|listener|control-plane|surfaceId>`, exitCode: 2 };
    const resolved = resolveSurfaceTarget(target);
    if (!resolved) return unknownSurface(target);
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
    const generatedNtfyTopics: { readonly setting: string; readonly topic: string }[] = [];
    if (resolved.kind === 'endpoint' && resolved.endpoint === 'web') {
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
    else if (resolved.kind === 'endpoint' && resolved.endpoint === 'httpListener') {
      if (enabled) {
        const listenerError = applyTargetEndpointFlagsOrDefault(runtime, 'httpListener');
        if (listenerError) return refuse(listenerError);
        reached.push('httpListener');
      }
      config.setDynamic('danger.httpListener', enabled);
    }
    else if (resolved.kind === 'endpoint') {
      if (enabled) {
        const controlPlaneError = applyTargetEndpointFlagsOrDefault(runtime, 'controlPlane');
        if (controlPlaneError) return refuse(controlPlaneError);
        reached.push('controlPlane');
      }
      // control-plane on: serve other machines (the daemon must run for that);
      // off: serve only this machine. The daemon itself stays as it is.
      config.setDynamic('controlPlane.enabled', enabled);
      if (enabled) config.setDynamic('daemon.enabled', true);
    }
    else {
      if (enabled) {
        // An external surface receives its traffic on the HTTP listener, so enabling one opens that listener.
        const listenerError = applyTargetEndpointFlagsOrDefault(runtime, 'httpListener');
        if (listenerError) return refuse(listenerError);
        reached.push('httpListener');
        enableFeatureFlags(config, getServerSurfaceFeatureFlags({ serverBacked: true, externalSurfaces: [resolved.id] }));
        config.setDynamic('danger.httpListener', true);
      }
      config.setDynamic(`surfaces.${resolved.id}.enabled` as ConfigKey, enabled);
      if (enabled && resolved.id === 'ntfy') {
        // On the public server a topic name is the only secret: each unset inbound topic gets an unguessable one.
        // Each name is a credential: it goes to the daemon's secret tier and the setting holds its reference.
        const secrets = ntfyTopicSecrets(runtime);
        try {
          generatedNtfyTopics.push(...await ensureNtfyTopics({
            get: (key) => config.get(key as ConfigKey),
            store: async (key, topic) => {
              const secretKey = buildGoodVibesSecretKey(key);
              await secrets.set(secretKey, topic, { scope: 'daemon' });
              config.setDynamic(key as ConfigKey, buildGoodVibesSecretRef(secretKey));
            },
          }));
        } finally {
          secrets.close();
        }
      }
    }
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
      for (const { setting, topic } of generatedNtfyTopics) {
        lines.push(`  ${setting} set to ${topic}; subscribe to that topic in the ntfy app to reach this machine.`);
      }
      if (resolved.kind === 'external') {
        // Enabled is not working: name what the channel still lacks.
        const missing = missingSurfaceKeys(config, resolved.id);
        if (missing.length > 0) {
          lines.push(`  still needs: ${missing.join(', ')}. Set each in the TUI with /config set <key> <value> (a token may be a goodvibes://secrets/ reference), then run goodvibes surfaces check ${resolved.id}.`);
        }
      }
    } else if (resolved.kind === 'external') {
      lines.push(...sharedSettingsLeftOn(config, resolved.id));
    } else {
      if (resolved.kind === 'endpoint' && resolved.endpoint === 'controlPlane') {
        lines.push('  The daemon keeps serving this machine; requests from other machines are refused.');
      }
      lines.push('  Its network settings are left as they are; run `goodvibes surfaces list` to see them.');
    }
    return { output: lines.join('\n'), exitCode: 0 };
  }
  if (sub !== 'list' && sub !== 'status' && sub !== 'check' && sub !== 'show') {
    return { output: 'Usage: goodvibes surfaces [list|check [<surface>]|show <surface>|enable <surface>|disable <surface>]   (surface: web, listener, control-plane or a channel id)', exitCode: 2 };
  }
  const resolved = target ? resolveSurfaceTarget(target) : undefined;
  if (target && !resolved) return unknownSurface(target);
  const endpointTarget = resolved?.kind === 'endpoint' ? resolved.endpoint : undefined;
  const externalTarget = resolved?.kind === 'external' ? resolved.id : undefined;
  const controlPlane = resolveRuntimeEndpointBinding(config, 'controlPlane');
  const web = resolveRuntimeEndpointBinding(config, 'web');
  const httpListener = resolveRuntimeEndpointBinding(config, 'httpListener');
  const includeProbe = sub === 'check';
  /** Endpoints this run reports on: all of them, or the one named. */
  const shows = (endpoint: RuntimeEndpointId): boolean => !endpointTarget || endpointTarget === endpoint;
  const shouldProbeControlPlane = includeProbe && (!target || endpointTarget === 'controlPlane' || endpointTarget === 'web');
  const shouldProbeListener = includeProbe && (!target || externalTarget !== undefined || endpointTarget === 'httpListener');
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
  const filteredSurfaces = !target ? externalSurfaces : externalSurfaces.filter((surface) => surface.id === externalTarget);
  // The owner's own command shows the topic names he subscribes to; each is read from the secret store its setting names.
  const showsNtfy = filteredSurfaces.some((surface) => surface.id === 'ntfy');
  const topicSecrets = showsNtfy ? ntfyTopicSecrets(runtime) : null;
  const topicNames = topicSecrets
    ? await Promise.all(['surfaces.ntfy.chatTopic', 'surfaces.ntfy.agentTopic', 'surfaces.ntfy.remoteTopic', 'surfaces.ntfy.topic']
      .map((key) => ntfyTopicName(runtime, topicSecrets, key))).finally(() => topicSecrets.close())
    : ['', '', '', ''];
  const ntfyTopics = resolveGoodVibesNtfyTopics({
    chatTopic: topicNames[0],
    agentTopic: topicNames[1],
    remoteTopic: topicNames[2],
    baseUrl: String(config.get('surfaces.ntfy.baseUrl' as ConfigKey) || ''),
  });
  const readinessIssues: string[] = [];
  for (const [endpointLabel, endpointBinding] of [['controlPlane', controlPlane], ['web', web], ['httpListener', httpListener]] as const) {
    if (!shows(endpointLabel)) continue;
    if (!endpointBinding.recognized) {
      readinessIssues.push(`${endpointLabel}.hostMode '${endpointBinding.hostMode}' is not a recognized mode (local|network|custom); the daemon cannot bind this endpoint until it is corrected.`);
    }
  }
  // The daemon's control plane serves this machine whenever the daemon runs;
  // controlPlane.enabled only adds other machines, so reachability is checked
  // whenever the daemon is on.
  const daemonEnabled = resolveDaemonEnabled(config);
  if (shouldProbeControlPlane && endpointTarget !== 'web' && controlPlane.recognized && daemonEnabled && !controlPlaneReachable) {
    readinessIssues.push(`The daemon is on but its control plane is not reachable on ${controlPlane.host}:${controlPlane.port}.`);
  }
  if (endpointTarget === 'web' && includeProbe && config.get('web.enabled') === true && controlPlane.recognized && !controlPlaneReachable) {
    readinessIssues.push(`Web is enabled but the control plane that serves it is not reachable on ${controlPlane.host}:${controlPlane.port}.`);
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
      enabled: daemonEnabled,
      servesOtherMachines: daemonEnabled && config.get('controlPlane.enabled') === true,
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
    ...(target ? { target } : {}),
    surfaces: filteredSurfaces,
    readinessIssues,
  };
  const reachableText = (reachable: boolean | undefined): string => includeProbe && reachable !== undefined ? ` reachable=${yesNo(reachable)}` : '';
  const output = formatJsonOrText(runtime.cli)(value, [
    'GoodVibes surfaces',
    ...(shows('controlPlane') ? [
      `  control-plane: ${yesNo(value.controlPlane.enabled)} (${formatRuntimeEndpointBinding(value.controlPlane)})${reachableText(value.controlPlane.reachable)}`,
      `    serves other machines: ${yesNo(value.controlPlane.servesOtherMachines)} (controlPlane.enabled)`,
    ] : []),
    ...(shows('web') ? [`  web: ${yesNo(value.web.enabled)} (${formatRuntimeEndpointBinding(value.web)})${reachableText(value.web.reachable)}`] : []),
    ...(shows('httpListener') ? [`  http-listener: ${yesNo(value.httpListener.enabled)} (${formatRuntimeEndpointBinding(value.httpListener)})${reachableText(value.httpListener.reachable)}`] : []),
    ...(endpointTarget ? [] : ['', 'External surfaces:']),
    ...value.surfaces.map((surface) => `  ${surface.label.padEnd(16)} enabled=${yesNo(surface.enabled)} ready=${yesNo(surface.ready)}${surface.enabled && surface.missing.length > 0 ? ` missing=${surface.missing.join(',')}` : ''}${surface.enabled && surface.missingFeatureFlags.length > 0 ? ` settingsOff=${surfaceFeatureGateSettingsKeys(surface.missingFeatureFlags).join(',')}` : ''}`),
    ...(filteredSurfaces.some((surface) => surface.id === 'ntfy') ? [
      '',
      'ntfy inbound topics:',
      `  chat: ${ntfyTopics.chatTopic || '(none)'}`,
      `  agent: ${ntfyTopics.agentTopic || '(none)'}`,
      `  daemon-only remote: ${ntfyTopics.remoteTopic || '(none)'}`,
      ...ntfyTopics.refused.map((refused) => `  not subscribed: ${refused.reason}`),
      `  default delivery topic: ${topicNames[3] || '(none)'}`,
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
  // The service rules read what the service manager reports; `goodvibes service check` and doctor apply them.
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

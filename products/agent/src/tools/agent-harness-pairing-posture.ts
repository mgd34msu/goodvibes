import { relative } from 'node:path';
import type { CommandContext } from '../input/command-registry.ts';
import { GOODVIBES_AGENT_PAIRING_SURFACE } from '../config/surface.ts';
import { resolveRuntimeEndpointBinding, type RuntimeEndpointConfigReader } from '../cli/endpoints.ts';
import { readConnectedHostOperatorToken } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-auth';
import { buildAgentWorkspaceChannels } from '../input/agent-workspace-channels.ts';
import { buildAgentWorkspaceVoiceMediaReadiness } from '../input/agent-workspace-voice-media.ts';
import { requirePlatform, requireShellPaths } from '../input/commands/runtime-services.ts';
import { browserControlPosture, type BrowserControlPosture } from './agent-harness-browser-control.ts';
import { browserDeviceCatalogMatches } from './agent-harness-browser-device-readings.ts';
import { captureCatalogNativeFacts, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import type { CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';
import { captureAsyncHarnessInput } from './agent-harness-async-input.ts';
import { deviceLiveReadModelSnapshot, deviceLiveRecordsFor, SENSOR_DEVICE_CAPABILITY_IDS, type DeviceLiveCapabilityRecord } from './agent-harness-device-live-read-models.ts';
import { previewHarnessText } from '@goodvibes-jev/engine/terminal-shell/agent-turn/preview-text';
import { clampReadLimit } from '@goodvibes-jev/engine/terminal-shell/agent-turn/read-helpers';
import { formatHttpOrigin, isWildcardBindHost, probeStableHostInputs, stableUrlHostForBindHost, type StableHostInputs } from '@goodvibes-jev/engine/platform/platform/pairing';

export interface AgentHarnessPairingArgs {
  readonly pairingRouteId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type PairingResolution =
  | { readonly status: 'found'; readonly route: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

type PairingLookupSource = 'pairingRouteId' | 'target' | 'query';

interface PairingRoute {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly effect: 'read-only' | 'visible-navigation' | 'owner-terminal-only' | 'confirmed-local-auth-provisioning';
  readonly command?: string;
  readonly harnessRoute?: string;
  readonly capabilityIds?: readonly string[];
  readonly requiresConfirmation?: boolean;
}

type DeviceCapabilityStatus = 'ready' | 'attention' | 'setup-needed' | 'not-published';

interface DeviceCapability {
  readonly id: string;
  readonly label: string;
  readonly domain: 'companion' | 'browser' | 'voice' | 'delivery' | 'desktop' | 'device';
  readonly status: DeviceCapabilityStatus;
  readonly userOutcome: string;
  readonly summary: string;
  readonly nextStep: string;
  readonly capabilities: readonly string[];
  readonly modelRoute: string;
  readonly userRoute?: string;
  readonly setupRoutes?: readonly string[];
  readonly evidence?: Record<string, unknown>;
  readonly policy: string;
}

interface DeviceCapabilityMap {
  readonly summary: {
    readonly total: number;
    readonly ready: number;
    readonly attention: number;
    readonly setupNeeded: number;
    readonly notPublished: number;
    readonly primaryNextStep: string;
  };
  readonly capabilities: readonly DeviceCapability[];
  readonly policy: string;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 500);
}

function readConfigBoolean(context: CommandContext, key: string, fallback: boolean): boolean {
  try {
    const value = (context.platform.configManager as { get(settingKey: string): unknown }).get(key);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

/** The setting, or null when reading it failed: a failed read is not the same as the setting being off. */
export function readConfigBooleanOrNull(context: CommandContext, key: string): boolean | null {
  try {
    const value = (context.platform.configManager as { get(settingKey: string): unknown }).get(key);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return false;
  } catch {
    return null;
  }
}

function readConfigStringArray(context: CommandContext, key: string): readonly string[] {
  try {
    const value = (context.platform.configManager as { get(settingKey: string): unknown }).get(key);
    if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    if (typeof value === 'string' && value.trim().length > 0) return [value.trim()];
    return [];
  } catch {
    return [];
  }
}

/**
 * The facts a wildcard-bound endpoint's advertised host is chosen from, read
 * once before the route's first await: the engine's stable-host inputs, the
 * same ones the printed pairing link uses. Null when neither endpoint is
 * wildcard-bound, since an explicit bind host is advertised as it is.
 */
export function capturePairingHostInputs(config: RuntimeEndpointConfigReader): StableHostInputs | null {
  const wildcard = (['controlPlane', 'web'] as const).some(id => isWildcardBindHost(resolveRuntimeEndpointBinding(config, id).host));
  return wildcard ? Object.freeze({ ...probeStableHostInputs() }) : null;
}

/**
 * Where another device reaches an endpoint, by the engine's one stable-host
 * rule: the host, what kind of host it is (a Tailscale or `.local` name that
 * survives a lease change, or an interface address that may not be the one a
 * phone can reach), and for a name the routable address beside it.
 */
function advertisedEndpoint(bindHost: string, port: number, inputs: StableHostInputs | null): Record<string, unknown> & { readonly url: string } {
  const resolved = stableUrlHostForBindHost(bindHost, () => inputs ?? probeStableHostInputs());
  return {
    advertisedHost: resolved.host,
    hostKind: resolved.kind,
    hostStable: resolved.stable,
    url: formatHttpOrigin(resolved.host, port),
    ...(resolved.alternateHost ? { alternateUrl: formatHttpOrigin(resolved.alternateHost, port) } : {}),
  };
}

function lookupFromArgs(args: AgentHarnessPairingArgs): { readonly source: PairingLookupSource; readonly input: string } | null {
  const pairingRouteId = readString(args.pairingRouteId);
  if (pairingRouteId) return { source: 'pairingRouteId', input: pairingRouteId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function pairingRoutes(): readonly PairingRoute[] {
  return [
    {
      id: 'qr-pairing',
      label: 'QR pairing',
      detail: 'Owner-terminal route: the user types /pair (optionally --name <device name>) in the live Agent terminal; it mints a named, revocable device token on the connected host and shows its link and QR code. Granting a new device access is the owner's to type, so a model invocation of /pair is refused. The device token is revoked in the web app under settings, security, devices.',
      effect: 'owner-terminal-only',
      command: '/pair',
    },
    {
      id: 'pairing-ui',
      label: 'Pairing workspace route',
      detail: 'Visible Agent workspace route for companion pairing and channel setup.',
      effect: 'visible-navigation',
      command: '/agent channels',
      harnessRoute: 'agent_harness mode:"workspace_action" target:"pair"',
      capabilityIds: ['companion-pairing', 'mobile-command-routing'],
    },
    {
      id: 'connected-host-token-provisioning',
      label: 'Connected-host token provisioning',
      detail: 'Confirmed platform-backed route that creates or repairs the local canonical connected-host token file without printing the raw token.',
      effect: 'confirmed-local-auth-provisioning',
      harnessRoute: 'setup action:"token" setupItemId:"connected-host-auth" confirm:true explicitUserRequest:"..."',
      capabilityIds: ['connected-host-status', 'companion-pairing'],
      requiresConfirmation: true,
    },
    {
      id: 'connected-host-status',
      label: 'Connected host live posture',
      detail: 'Read-only reachability, token posture, and route readiness used before companion setup.',
      effect: 'read-only',
      harnessRoute: 'host action:"status"',
      capabilityIds: ['connected-host-status'],
    },
    {
      id: 'companion-capabilities',
      label: 'Companion capability map',
      detail: 'Allowed and blocked companion route families for pairing, shared sessions, tasks, approvals, provider/model changes, attachments, and mobile command surfaces.',
      effect: 'read-only',
      harnessRoute: 'host action:"capabilities"',
      capabilityIds: [
        'companion-pairing',
        'shared-session',
        'task-management',
        'approval-actions',
        'provider-model-routing',
        'attachment-upload',
        'mobile-command-routing',
      ],
    },
    {
      id: 'device-capability-map',
      label: 'Device capability map',
      detail: 'Read-only mobile, browser/PWA, voice, notification, browser/desktop, camera, screen, location, and device-command readiness map with honest setup and not-published states.',
      effect: 'read-only',
      harnessRoute: 'agent_harness mode:"pairing_posture" query:"device" includeParameters:true',
      capabilityIds: [
        'companion-pairing',
        'mobile-command-routing',
        'browser-cockpit-pwa',
        'voice-controls',
        'tts-spoken-responses',
        'notifications',
        'browser-desktop-control',
        'camera-location-sensors',
      ],
    },
    {
      id: 'channels-readiness',
      label: 'Channel readiness',
      detail: 'Read-only channel setup and delivery posture used after pairing when messages or reminders need an explicit delivery target.',
      effect: 'read-only',
      command: '/channels',
      harnessRoute: 'channels action:"status"',
      capabilityIds: ['channels', 'notifications'],
    },
  ];
}

function pairingCatalogDescription(route: PairingRoute): string {
  return [route.label, route.detail, route.effect, route.command ?? '', route.harnessRoute ?? ''].join('\n');
}

function describeCandidate(route: PairingRoute): Record<string, unknown> {
  return {
    pairingRouteId: route.id,
    label: route.label,
    effect: route.effect,
    requiresConfirmation: route.requiresConfirmation === true,
    modelRoute: pairingRouteModelRoute(route),
  };
}

function describeRoute(route: PairingRoute, options: {
  readonly includeParameters?: boolean;
  readonly lookup?: Record<string, unknown>;
  readonly deviceCapabilityMap?: DeviceCapabilityMap;
} = {}): Record<string, unknown> {
  return {
    pairingRouteId: route.id,
    label: route.label,
    ...(options.includeParameters ? { detail: route.detail } : { summary: previewHarnessText(route.detail) }),
    effect: route.effect,
    requiresConfirmation: route.requiresConfirmation === true,
    modelRoute: pairingRouteModelRoute(route),
    ...(options.includeParameters ? {
      ...(route.command ? { command: route.command } : {}),
      ...(route.harnessRoute ? { harnessRoute: route.harnessRoute } : {}),
      ...(route.capabilityIds ? { capabilityIds: route.capabilityIds } : {}),
    } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters ? {
      policy: {
        effect: route.effect,
        values: 'Pairing posture returns the endpoint binding with its advertised address, and token presence only; raw companion tokens, QR payloads and the absolute token file path are never returned by this read-only mode.',
        mutation: 'Device pairing (/pair, which mints a device token) is an owner-terminal flow that a model cannot run. Companion connection, channel sends, provider/model changes, approval actions, and attachment flows stay explicit visible user flows.',
      },
      modelAccess: {
        inspectPairing: 'agent_harness mode:"pairing_posture"',
        inspectRoute: 'agent_harness mode:"pairing_route"',
        connectedHostStatus: 'host action:"status"',
        connectedHostCapabilities: 'host action:"capabilities"',
        channels: 'channels action:"status"',
      },
    } : {}),
    ...(options.includeParameters && route.id === 'device-capability-map' && options.deviceCapabilityMap ? {
      deviceCapabilityMap: options.deviceCapabilityMap,
    } : {}),
  };
}

function pairingRouteModelRoute(route: PairingRoute): string {
  if (route.effect === 'owner-terminal-only') return `none for a model; ask the user to type ${route.command ?? '/pair'}`;
  if (route.id === 'pairing-ui') return 'agent_harness mode:"workspace_action" target:"pair"';
  return previewHarnessText(route.harnessRoute ?? 'agent_harness mode:"pairing_route"');
}

function homeRelativeLabel(home: string, absolute: string): string {
  const inside = relative(home, absolute);
  return inside === '' || inside.startsWith('..') ? '<outside the home directory>' : `<home>/${inside.split('\\').join('/')}`;
}

function pairingState(context: CommandContext, hostInputs: StableHostInputs | null): Record<string, unknown> {
  const shellPaths = requireShellPaths(context);
  const configManager = requirePlatform(context).configManager;
  const tokenRecord = readConnectedHostOperatorToken(shellPaths.homeDirectory);
  const binding = resolveRuntimeEndpointBinding(configManager, 'controlPlane');
  return {
    surface: GOODVIBES_AGENT_PAIRING_SURFACE,
    endpoint: {
      endpointId: 'controlPlane',
      // null when the setting could not be read, which is not the same as disabled.
      enabled: readConfigBooleanOrNull(context, 'controlPlane.enabled'),
      bindHost: binding.host,
      port: binding.port,
      ...advertisedEndpoint(binding.host, binding.port, hostInputs),
    },
    token: {
      present: Boolean(tokenRecord.token),
      // Never the absolute path: it names the user's home directory.
      path: homeRelativeLabel(shellPaths.homeDirectory, tokenRecord.path),
      rawValueReturned: false,
    },
    companionPayloadReturned: false,
  };
}

function tokenPresent(state: Record<string, unknown>): boolean {
  const token = state.token as { readonly present?: boolean } | undefined;
  return token?.present === true;
}

function endpointEnabled(state: Record<string, unknown>): boolean {
  const endpoint = state.endpoint as { readonly enabled?: boolean | null } | undefined;
  return endpoint?.enabled === true;
}

function endpointEnabledUnknown(state: Record<string, unknown>): boolean {
  const endpoint = state.endpoint as { readonly enabled?: boolean | null } | undefined;
  return endpoint?.enabled === null;
}

function deviceStatusRank(status: DeviceCapabilityStatus): number {
  if (status === 'attention') return 0;
  if (status === 'setup-needed') return 1;
  if (status === 'not-published') return 2;
  return 3;
}

function deviceCatalogDescription(capability: DeviceCapability): string {
  return [capability.label, capability.userOutcome, capability.summary, capability.nextStep].join('\n');
}

async function queryRequestsWholeDeviceMap(query: string, deviceMap: DeviceCapabilityMap,
  options: CatalogRankingOptions): Promise<boolean> {
  if (!query) return true;
  const matched = await browserDeviceCatalogMatches([{ id: 'whole-device-map', deviceMap }], query, entry => ({
    id: entry.id,
    description: 'The complete companion and mobile device capability catalog. A request to inspect the whole map, its general device, phone or mobile posture, rather than one specific capability.',
    evidence: entry,
  }), options, 'agent.pairing.whole-device-map.query');
  return matched.length === 1;
}

function liveDeviceEvidence(records: readonly DeviceLiveCapabilityRecord[]): Record<string, unknown> | undefined {
  return records.length > 0 ? { liveRecords: records.slice(0, 5) } : undefined;
}

async function buildDeviceCapabilityMap(context: CommandContext, browserPosture: BrowserControlPosture, options: CatalogRankingOptions, hostInputs: StableHostInputs | null): Promise<DeviceCapabilityMap> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const state = pairingState(context, hostInputs);
  const hasToken = tokenPresent(state);
  const controlPlaneReady = endpointEnabled(state) && hasToken;
  const webEnabled = readConfigBooleanOrNull(context, 'web.enabled');
  const webBinding = resolveRuntimeEndpointBinding(requirePlatform(context).configManager, 'web');
  const webUrl = advertisedEndpoint(webBinding.host, webBinding.port, hostInputs).url;
  const voiceEnabled = readConfigBooleanOrNull(context, 'ui.voiceEnabled');
  const voiceReadiness = buildAgentWorkspaceVoiceMediaReadiness({
    context,
    voiceProviders: context.platform.voiceProviderRegistry?.list() ?? [],
    mediaProviders: context.platform.mediaProviderRegistry?.list() ?? [],
  });
  const channels = buildAgentWorkspaceChannels(context);
  const readyChannels = channels.filter((channel) => channel.ready);
  const enabledChannels = channels.filter((channel) => channel.enabled);
  const notificationWebhookCount = readConfigStringArray(context, 'notifications.webhookUrls').length;
  const liveDevice = await deviceLiveReadModelSnapshot(context, options);
  const sensorRecords = deviceLiveRecordsFor(liveDevice, SENSOR_DEVICE_CAPABILITY_IDS);
  const sensorReady = sensorRecords.length > 0;
  const ttsStatus: DeviceCapabilityStatus = voiceReadiness.selectedTtsProviderStatus === 'ready' && voiceReadiness.ttsVoiceConfigured
    ? 'ready'
    : voiceReadiness.selectedTtsProviderStatus === 'ready' || voiceReadiness.selectedTtsProviderStatus === 'ready-agent-env' || voiceReadiness.selectedTtsProviderStatus === 'registered'
      ? 'attention'
      : 'setup-needed';
  const notificationStatus: DeviceCapabilityStatus = readyChannels.length > 0 || notificationWebhookCount > 0
    ? 'ready'
    : enabledChannels.length > 0
      ? 'attention'
      : 'setup-needed';
  const capabilities: DeviceCapability[] = [
    {
      id: 'companion-pairing',
      label: 'Companion pairing',
      domain: 'companion',
      // The QR leads the phone to the control plane: a token alone pairs to a listener that is not running.
      status: controlPlaneReady ? 'ready' : hasToken && endpointEnabledUnknown(state) ? 'attention' : 'setup-needed',
      userOutcome: 'Pair a phone or companion surface without exposing the raw operator token in chat.',
      summary: controlPlaneReady
        ? 'A connected-host operator token is present and the control plane is enabled; pairing is an owner-terminal flow the user starts with /pair, which mints a named, revocable device token on the connected host and shows its link and QR code.'
        : !hasToken
          ? 'No connected-host operator token is present, so companion pairing needs local token provisioning first.'
          : endpointEnabledUnknown(state)
            ? 'A connected-host operator token is present, but the control-plane setting could not be read, so the pairing QR may point at a listener that is not running.'
            : 'A connected-host operator token is present, but the control plane is disabled, so a pairing QR would point at a listener that is not running.',
      nextStep: controlPlaneReady
        ? 'Ask the user to type /pair in the live Agent terminal when they want to pair a companion.'
        : !hasToken
          ? 'Provision connected-host auth (setupRoutes), then enable the control plane before QR pairing.'
          : 'Enable the control plane (host action:"service" endpointId:"controlPlane"), then ask the user to type /pair.',
      capabilities: ['QR pairing', 'pairing link', 'revocable device token'],
      modelRoute: 'agent_harness mode:"pairing_route" pairingRouteId:"qr-pairing"',
      userRoute: '/pair',
      setupRoutes: [
        'setup action:"item" setupItemId:"connected-host-auth"',
        'setup action:"token" setupItemId:"connected-host-auth" confirm:true explicitUserRequest:"..."',
        'host action:"service" endpointId:"controlPlane"',
      ],
      evidence: {
        tokenPresent: hasToken,
        controlPlaneEnabled: endpointEnabledUnknown(state) ? null : endpointEnabled(state),
        rawTokenReturned: false,
      },
      policy: 'Pairing display and the raw-token fallback are owner-terminal flows; a model invocation of /pair is refused.',
    },
    {
      id: 'mobile-command-routing',
      label: 'Mobile command routing',
      domain: 'companion',
      status: controlPlaneReady ? 'ready' : endpointEnabled(state) || endpointEnabledUnknown(state) ? 'attention' : 'setup-needed',
      userOutcome: 'Send commands from a companion surface into the same visible Agent control plane.',
      summary: controlPlaneReady
        ? 'Control-plane routing and operator auth are both configured.'
        : endpointEnabledUnknown(state)
          ? 'The control-plane setting could not be read, so mobile command routing cannot be assessed.'
        : endpointEnabled(state)
          ? 'The control plane is enabled, but companion auth is not ready.'
          : 'The control plane is disabled, so mobile command routing is not reachable yet.',
      nextStep: controlPlaneReady
        ? 'Use connected-host status before accepting companion-originated work.'
        : 'Enable and authenticate the control plane before relying on mobile command routing.',
      capabilities: ['shared session routing', 'task handoff', 'approval handoff', 'provider/model routing'],
      modelRoute: 'host action:"status"',
      setupRoutes: [
        'host action:"service" endpointId:"controlPlane"',
        'setup action:"item" setupItemId:"connected-host-auth"',
      ],
      evidence: {
        controlPlaneEnabled: endpointEnabledUnknown(state) ? null : endpointEnabled(state),
        tokenPresent: hasToken,
      },
      policy: 'Companion-originated tasks, approvals, sends, and provider/model changes remain explicit visible routes.',
    },
    {
      id: 'browser-cockpit-pwa',
      label: 'Browser cockpit/PWA',
      domain: 'browser',
      status: webEnabled ? 'ready' : webEnabled === null ? 'attention' : 'setup-needed',
      userOutcome: 'Use the connected-host browser cockpit from desktop or mobile without returning to the terminal.',
      summary: webEnabled
        ? `The connected-host web endpoint is enabled at ${webUrl}.`
        : webEnabled === null
          ? 'The web.enabled setting could not be read, so the browser cockpit/PWA state is unknown.'
          : 'The connected-host web endpoint is disabled, so the browser cockpit/PWA cannot open yet.',
      nextStep: webEnabled
        ? 'Open the connected browser cockpit when the user confirms a browser handoff.'
        : 'Inspect the web service endpoint and enable the host web surface only when the user wants browser access.',
      capabilities: ['responsive browser workspace', 'PWA route', 'mobile-friendly cockpit'],
      modelRoute: 'agent_harness mode:"open_ui_surface" surfaceId:"connected-browser-cockpit" explicitUserRequest:"..."',
      setupRoutes: [
        'agent_harness mode:"ui_surface" surfaceId:"connected-browser-cockpit"',
        'host action:"service" endpointId:"web"',
      ],
      evidence: {
        webEnabled,
        webEndpoint: webEnabled ? webUrl : null,
      },
      policy: 'Opening external browser surfaces is confirmation-gated and never mutates host state by inspection alone.',
    },
    {
      id: 'voice-controls',
      label: 'Voice controls',
      domain: 'voice',
      status: voiceEnabled && voiceReadiness.readyVoiceProviderCount > 0 ? 'ready' : voiceEnabled || voiceEnabled === null ? 'attention' : 'setup-needed',
      userOutcome: 'Talk to the assistant through an intentionally enabled voice surface.',
      summary: voiceEnabled
        ? `${voiceReadiness.readyVoiceProviderCount}/${voiceReadiness.voiceProviders.length} voice provider(s) are ready.`
        : voiceEnabled === null ? 'The ui.voiceEnabled setting could not be read, so the voice surface state is unknown.' : 'The voice surface is disabled.',
      nextStep: voiceEnabled
        ? 'Review media posture for provider or voice setup blockers before claiming hands-free use.'
        : 'Enable voice only after the user asks for spoken or push-to-talk interaction.',
      capabilities: ['voice surface toggle', 'push-to-talk setup posture', 'provider readiness'],
      modelRoute: 'agent_harness mode:"media_posture" query:"voice" includeParameters:true',
      setupRoutes: [
        'settings action:"get" query:"ui.voiceEnabled" includeParameters:true',
        'agent_harness mode:"media_posture" query:"voice" includeParameters:true',
      ],
      evidence: {
        voiceSurfaceEnabled: voiceEnabled,
        readyVoiceProviders: voiceReadiness.readyVoiceProviderCount,
        totalVoiceProviders: voiceReadiness.voiceProviders.length,
      },
      policy: 'Voice enablement and provider changes stay visible settings or media-provider flows.',
    },
    {
      id: 'tts-spoken-responses',
      label: 'Spoken responses',
      domain: 'voice',
      status: ttsStatus,
      userOutcome: 'Hear assistant responses with a predictable provider and voice.',
      summary: `${voiceReadiness.selectedTtsProviderLabel} is ${voiceReadiness.selectedTtsProviderStatus}; voice configured=${voiceReadiness.ttsVoiceConfigured ? 'yes' : 'no'}.`,
      nextStep: ttsStatus === 'ready'
        ? 'Use explicit TTS routes when the user asks for spoken output.'
        : 'Choose a ready TTS provider and voice before presenting spoken replies as ready.',
      capabilities: ['TTS provider selection', 'voice picker', 'spoken reply route'],
      modelRoute: 'agent_harness mode:"media_posture" query:"tts" includeParameters:true',
      setupRoutes: [
        'agent_harness mode:"open_ui_surface" surfaceId:"tts-provider-picker" explicitUserRequest:"..."',
        'agent_harness mode:"open_ui_surface" surfaceId:"tts-voice-picker" explicitUserRequest:"..."',
      ],
      evidence: {
        selectedTtsProviderStatus: voiceReadiness.selectedTtsProviderStatus,
        ttsVoiceConfigured: voiceReadiness.ttsVoiceConfigured,
      },
      policy: 'Spoken replies and TTS setting changes require explicit user-visible routes.',
    },
    {
      id: 'notifications',
      label: 'Notifications and delivery',
      domain: 'delivery',
      status: notificationStatus,
      userOutcome: 'Receive completion/status messages through a chosen channel without hidden sends.',
      summary: `${readyChannels.length}/${channels.length} channel(s) ready; ${notificationWebhookCount} notification webhook target(s) configured.`,
      nextStep: notificationStatus === 'ready'
        ? 'Use explicit confirmed send/test routes only for the channel the user chose.'
        : enabledChannels.length > 0
          ? 'Finish setup for enabled channels before relying on notifications.'
          : 'Choose one notification channel intentionally, then configure only that surface.',
      capabilities: ['channel delivery', 'desktop notification posture', 'webhook notification posture'],
      modelRoute: 'channels action:"setup"',
      userRoute: '/channels',
      setupRoutes: [
        'channels action:"status" includeParameters:true',
        'channels action:"setup"',
        'agent_harness mode:"notifications"',
      ],
      evidence: {
        readyChannels: readyChannels.length,
        enabledChannels: enabledChannels.length,
        notificationWebhookTargets: notificationWebhookCount,
      },
      policy: 'Delivery tests and outbound messages require explicit confirmed user action.',
    },
    {
      id: 'browser-desktop-control',
      label: 'Browser and desktop control',
      domain: 'desktop',
      status: browserPosture.status,
      userOutcome: 'Control browser, screen, or desktop surfaces only through trusted configured tools.',
      summary: browserPosture.configured
        ? 'A browser/desktop control route is configured.'
        : browserPosture.needsReview
          ? 'Browser/desktop tooling exists but needs trust or schema review.'
          : 'No trusted browser/desktop control route is configured.',
      nextStep: browserPosture.recommendedRoute,
      capabilities: ['browser navigation', 'screenshot/screen observation', 'desktop control'],
      modelRoute: browserPosture.recommendedRoute,
      setupRoutes: [
        browserPosture.setupRoute,
        'execution action:"status" query:"browser desktop" includeParameters:true',
      ],
      evidence: {
        declaredControlTools: browserPosture.declaredControlTools,
        mcpServers: browserPosture.mcpServers.length,
      },
      policy: browserPosture.policy,
    },
    {
      id: 'camera-location-sensors',
      label: 'Camera, screen, and location sensors',
      domain: 'device',
      status: sensorReady ? 'ready' : liveDevice.unavailable ? 'attention' : 'setup-needed',
      userOutcome: 'Use the paired phone\'s camera, screen, location or device commands; each request is granted or asked under permissions.mode by the daemon.',
      summary: sensorReady
        ? `${new Set(sensorRecords.map((record) => record.nodeId)).size} paired device(s) serve ${new Set(sensorRecords.map((record) => record.capabilityId)).size} camera, screen, location or command capabilities (${sensorRecords.filter((record) => record.status === 'granted').length} with a live grant).`
        : liveDevice.unavailable
          ? `The device runtime could not be read: ${liveDevice.unavailable}`
          : liveDevice.pairedNodes > 0
            ? 'Paired devices are present but none serves a camera, screen, location or command capability right now.'
            : 'No device is paired.',
      nextStep: sensorReady
        ? 'Run a capability with phone action:"run" (or photo, screenshot, location, notify); the daemon asks the owner when no grant covers it.'
        : liveDevice.unavailable
          ? 'Check the connected host (host action:"status"), then read this posture again.'
          : 'Ask the owner to pair a phone (/pair in the Agent terminal).',
      capabilities: [
        'camera permission posture',
        'screen capture permission posture',
        'location permission posture',
        'local device command routes',
        ...new Set(sensorRecords.map((record) => record.capabilityId)),
      ],
      modelRoute: sensorRecords[0]?.modelRoute ?? 'phone action:"capabilities"',
      setupRoutes: [
        ...sensorRecords.slice(0, 3).map((record) => record.modelRoute),
        'phone action:"nodes"',
        'phone action:"grants"',
      ],
      evidence: {
        pairedNodes: liveDevice.pairedNodes,
        liveDeviceRecords: liveDevice.capabilities.length,
        ...(liveDevice.unavailable ? { unavailable: liveDevice.unavailable } : {}),
        ...liveDeviceEvidence(sensorRecords),
      },
      policy: 'Read from the daemon\'s device runtime (paired nodes and live grants). Every capability request is admitted by that runtime: a live grant, or the owner asked under permissions.mode.',
    },
  ];
  capabilities.sort((left, right) => deviceStatusRank(left.status) - deviceStatusRank(right.status) || left.label.localeCompare(right.label));
  const counts = {
    ready: capabilities.filter((capability) => capability.status === 'ready').length,
    attention: capabilities.filter((capability) => capability.status === 'attention').length,
    setupNeeded: capabilities.filter((capability) => capability.status === 'setup-needed').length,
    notPublished: capabilities.filter((capability) => capability.status === 'not-published').length,
  };
  const primaryNextStep = capabilities.find((capability) => capability.status !== 'ready')?.nextStep
    ?? 'All published companion device capabilities are ready; use explicit confirmed routes for effects.';
  return {
    summary: {
      total: capabilities.length,
      ...counts,
      primaryNextStep,
    },
    capabilities,
    policy: 'Read-only device capability map. It does not pair devices, send notifications, open browsers, change voice settings, capture screens, or claim unpublished sensor APIs.',
  };
}

export async function pairingPostureCatalogStatus(context: CommandContext, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const native = captureCatalogNativeFacts(context, 'pairing');
  const caller = captureAsyncHarnessInput({}, options, true);
  const childOptions = { ...caller.options, assertCurrent: caller.assertCallerCurrent };
  const hostInputs = capturePairingHostInputs(requirePlatform(context).configManager);
  const browserPosture = await browserControlPosture(context, context.extensions?.toolRegistry, childOptions);
  caller.assertCurrent();
  const deviceMap = await buildDeviceCapabilityMap(context, browserPosture, childOptions, hostInputs);
  caller.assertCurrent();
  const result = await withModelReadingSource({ nativeProviders: native.providerEvidence, deviceMap, hostInputs, state: pairingState(context, hostInputs) }, childOptions, async (captured, current) => {
    const state = captured.state;
    const result = {
      modes: ['pairing_posture', 'pairing_route'],
      routes: pairingRoutes().length,
      tokenPresent: tokenPresent(state),
      deviceCapabilitySummary: captured.deviceMap.summary,
      readOnly: true,
    };
    current.assertCurrent?.();
    return result;
  });
  caller.retainSourceCurrent('agent.pairing.sources');
  return result;
}

export async function pairingPostureSummary(context: CommandContext, rawArgs: AgentHarnessPairingArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const native = captureCatalogNativeFacts(context, 'pairing');
  const caller = captureAsyncHarnessInput(rawArgs, options, true), args = caller.args;
  const childOptions = { ...caller.options, assertCurrent: caller.assertCallerCurrent };
  const hostInputs = capturePairingHostInputs(requirePlatform(context).configManager);
  const browserPosture = await browserControlPosture(context, context.extensions?.toolRegistry, childOptions);
  caller.assertCurrent();
  const query = readString(args.query);
  const includeParameters = args.includeParameters === true;
  const routes = pairingRoutes();
  const deviceMap = await buildDeviceCapabilityMap(context, browserPosture, childOptions, hostInputs);
  caller.assertCurrent();
  const result = await withModelReadingSource({ nativeProviders: native.providerEvidence, routes, deviceMap, args, hostInputs, state: pairingState(context, hostInputs) }, childOptions, async (captured, current) => {
    const sourceOptions = current;
    const limit = readLimit(args.limit, 100);
    const matchingRoutes = await browserDeviceCatalogMatches(routes, query, route => ({
      id: route.id, description: pairingCatalogDescription(route), evidence: route,
    }), sourceOptions, 'agent.pairing.routes.query');
    caller.assertCurrent();
    const includeWholeDeviceMap = await queryRequestsWholeDeviceMap(query, deviceMap, sourceOptions);
    caller.assertCurrent();
    const matchingCapabilities = includeWholeDeviceMap ? deviceMap.capabilities : await browserDeviceCatalogMatches(deviceMap.capabilities, query, capability => ({
      id: capability.id, description: deviceCatalogDescription(capability), evidence: capability,
    }), sourceOptions, 'agent.pairing.capabilities.query');
    caller.assertCurrent();
    const filtered = matchingRoutes.slice(0, limit), filteredCapabilities = matchingCapabilities.slice(0, limit);
    const result = {
      status: 'available',
      summary: {
        deviceCapabilities: deviceMap.summary,
        returnedDeviceCapabilities: filteredCapabilities.length,
      },
      pairing: captured.state,
      deviceCapabilities: filteredCapabilities.map((capability) => includeParameters ? capability : {
        capabilityId: capability.id,
        label: capability.label,
        domain: capability.domain,
        status: capability.status,
        summary: previewHarnessText(capability.summary),
        modelRoute: capability.modelRoute,
      }),
      routes: filtered.map((route) => describeRoute(route, { includeParameters, deviceCapabilityMap: deviceMap })),
      returned: filtered.length,
      total: routes.length,
      policy: `${deviceMap.policy} Device pairing (/pair), companion connection, channel delivery, task, approval, provider/model, and attachment actions remain explicit visible user flows.`,
    };
    current.assertCurrent?.();
    return result;
  });
  caller.retainSourceCurrent('agent.pairing.sources');
  return result;
}

export async function describeHarnessPairingRoute(context: CommandContext, rawArgs: AgentHarnessPairingArgs,
  options: CatalogRankingOptions = {}): Promise<PairingResolution> {
  const caller = captureAsyncHarnessInput(rawArgs, options, true);
  const current = { ...caller.options, assertCurrent: caller.assertCallerCurrent };
  // The routes are constants: an id is a lookup, and only a free-text query is ranked.
  const result = await (async (): Promise<PairingResolution> => {
    const lookup = lookupFromArgs(caller.args);
    if (!lookup) return { status: 'missing_lookup', usage: 'pairing_route requires pairingRouteId, target, or query. Use mode:"pairing_posture" to inspect pairing route ids.' };
    const routes = pairingRoutes();
    const found = async (route: PairingRoute, resolvedBy: string): Promise<PairingResolution> => {
      let deviceCapabilityMap: DeviceCapabilityMap | undefined;
      if (route.id === 'device-capability-map') {
        const hostInputs = capturePairingHostInputs(requirePlatform(context).configManager);
        const browserPosture = await browserControlPosture(context, context.extensions?.toolRegistry, current);
        current.assertCurrent?.();
        deviceCapabilityMap = await buildDeviceCapabilityMap(context, browserPosture, current, hostInputs);
        current.assertCurrent?.();
      }
      const result: PairingResolution = { status: 'found', route: describeRoute(route, { includeParameters: true,
        lookup: { ...lookup, resolvedBy }, ...(deviceCapabilityMap ? { deviceCapabilityMap } : {}),
      }) };
      current.assertCurrent?.();
      return result;
    };
    const normalized = lookup.input.toLowerCase();
    const exact = routes.find(route => route.id === lookup.input);
    if (exact) return found(exact, 'id');
    const insensitive = routes.find(route => route.id.toLowerCase() === normalized);
    if (insensitive) return found(insensitive, 'case-insensitive-id');
    const searched = await browserDeviceCatalogMatches(routes, lookup.input, route => ({
      id: route.id, description: pairingCatalogDescription(route), evidence: route,
    }), current, 'agent.pairing.route.lookup');
    current.assertCurrent?.();
    if (searched.length === 1 && searched[0]) return found(searched[0], 'rank-band');
    if (searched.length > 1) return { status: 'ambiguous', input: lookup.input, candidates: searched.slice(0, 8).map(describeCandidate) };
    return { status: 'missing_lookup', usage: `Unknown pairing route ${lookup.input}. Use mode:"pairing_posture" to inspect pairing route ids.` };
  })();
  caller.retainSourceCurrent('agent.pairing.sources');
  return result;
}

import {
  onboardingAccessSignals,
  hasOnboardingWebhookIngress,
  onboardingIntegrationSignalCount,
  deriveOnboardingState,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-signals';
import { deriveReopenEditAcknowledgementState as deriveAcknowledgements } from '@goodvibes-jev/engine/terminal-shell/onboarding-signals';
import { countConfiguredSurfaceKinds, hasExternalIntegrations } from '@goodvibes-jev/engine/terminal-shell/onboarding-signals';
import '@goodvibes-jev/engine/terminal-shell/onboarding-values';
import '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/providers';
import type {
  OnboardingNetworkMode,
  OnboardingReopenEditAcknowledgementState,
  OnboardingSnapshotState,
  OnboardingStep1CapabilityItem,
  OnboardingStepDerivationState,
} from './types.ts';

function hasAnyServerEnabled(snapshot: OnboardingSnapshotState): boolean {
  return (
    snapshot.bindSettings.daemonEnabled ||
    snapshot.bindSettings.controlPlane.enabled ||
    snapshot.bindSettings.httpListenerEnabled ||
    snapshot.bindSettings.web.enabled
  );
}

function hasBrowserAccess(snapshot: OnboardingSnapshotState): boolean {
  return snapshot.bindSettings.web.enabled;
}

function isLoopbackHost(host: string | null | undefined): boolean {
  const normalized = (host ?? '').trim().toLowerCase();
  if (normalized.length === 0) return false;
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function isRemoteBind(hostMode: string, host: string | null | undefined, allowRemote = false): boolean {
  if (hostMode === 'network') return true;
  if (hostMode === 'local') return allowRemote;
  if (hostMode === 'custom') return !isLoopbackHost(host);
  return false;
}

function hasRemoteDeviceAccess(snapshot: OnboardingSnapshotState): boolean {
  return (
    ((snapshot.bindSettings.daemonEnabled || snapshot.bindSettings.controlPlane.enabled) &&
      isRemoteBind(
        snapshot.bindSettings.controlPlane.hostMode,
        snapshot.bindSettings.controlPlane.host,
        snapshot.bindSettings.controlPlane.allowRemote,
      )) ||
    (snapshot.bindSettings.web.enabled && isRemoteBind(snapshot.bindSettings.web.hostMode, snapshot.bindSettings.web.host))
  );
}

function hasWebhookOrEventIngress(snapshot: OnboardingSnapshotState): boolean {
  return snapshot.bindSettings.httpListenerEnabled || hasOnboardingWebhookIngress(snapshot);
}

function hasCloudflareBatch(snapshot: OnboardingSnapshotState): boolean {
  return (
    snapshot.config.cloudflare.enabled ||
    snapshot.config.batch.queueBackend === 'cloudflare' ||
    snapshot.config.batch.mode !== 'off' ||
    snapshot.config.cloudflare.accountId.trim().length > 0 ||
    snapshot.config.cloudflare.apiTokenRef.trim().length > 0 ||
    snapshot.config.cloudflare.workerBaseUrl.trim().length > 0
  );
}

function describeLocalTuiOnly(snapshot: OnboardingSnapshotState): string {
  // Honest wording (One-Platform daemon-by-default): this option turns off
  // browser/LAN/webhook/external-app exposure, but the loopback-only GoodVibes
  // daemon still runs by default so sessions here stay visible to other
  // GoodVibes surfaces on this machine. Turn it off in Settings > daemon if you
  // want none at all.
  if (!hasAnyServerEnabled(snapshot)) {
    return 'Use GoodVibes only in this terminal. No browser access, HTTP listener, external app surface, or network setup. A loopback-only background daemon still runs by default so sessions here stay visible to other GoodVibes surfaces on this machine; turn it off in Settings > daemon if you want none at all.';
  }

  return 'Turn off browser access, HTTP listeners, external app surfaces, and network setup. The loopback-only background daemon keeps running by default for cross-surface visibility unless you turn it off in Settings > daemon.';
}

function describeBrowserAccess(snapshot: OnboardingSnapshotState): string {
  return snapshot.bindSettings.web.enabled
    ? 'Keep the background service and web UI enabled. Network reachability is controlled on the next screen.'
    : 'Run the background service and web UI. GoodVibes will use the local network by default; you can restrict or customize it next.';
}

function describeRemoteDeviceAccess(snapshot: OnboardingSnapshotState): string {
  return hasRemoteDeviceAccess(snapshot)
    ? 'Keep enabled GoodVibes services reachable from other devices on your LAN. Local authentication is required.'
    : 'Make enabled GoodVibes services reachable from other devices on your LAN. Local authentication is required.';
}

function describeWebhookIngress(snapshot: OnboardingSnapshotState): string {
  return hasWebhookOrEventIngress(snapshot)
    ? 'Keep the HTTP listener available for incoming webhooks, callbacks, and automation events.'
    : 'Turn on the HTTP listener for incoming webhooks, callbacks, and automation events.';
}

function describeExternalIntegrations(snapshot: OnboardingSnapshotState): string {
  const integrationCount = onboardingIntegrationSignalCount(snapshot);

  if (integrationCount === 0) {
    return 'Enable setup screens for Slack, Discord, Telegram, Home Assistant, Teams, Matrix, and other app surfaces you choose.';
  }

  return `Review and configure ${integrationCount} detected external app, service, or surface integration signal(s).`;
}

function describeCloudflareBatch(snapshot: OnboardingSnapshotState): string {
  if (hasCloudflareBatch(snapshot)) {
    return 'Review Cloudflare Workers/Queues batch processing, token storage, and optional remote daemon provisioning settings.';
  }

  return 'Optionally configure Cloudflare Workers and Queues for explicit or eligible background batch jobs. Immediate local daemon behavior stays the default unless enabled.';
}

export function deriveStep1Capabilities(snapshot: OnboardingSnapshotState): readonly OnboardingStep1CapabilityItem[] {
  return [
    {
      id: 'local-tui-only',
      label: 'Local TUI Only (No Servers)',
      selected: !hasAnyServerEnabled(snapshot),
      detail: describeLocalTuiOnly(snapshot),
    },
    {
      id: 'browser-access',
      label: 'Open GoodVibes in a Browser',
      selected: hasBrowserAccess(snapshot),
      detail: describeBrowserAccess(snapshot),
    },
    {
      id: 'network-access',
      label: 'Let other devices use GoodVibes',
      selected: hasRemoteDeviceAccess(snapshot),
      detail: describeRemoteDeviceAccess(snapshot),
    },
    {
      id: 'webhook-events',
      label: 'Receive webhooks or events from other tools',
      selected: hasWebhookOrEventIngress(snapshot),
      detail: describeWebhookIngress(snapshot),
    },
    {
      id: 'external-integrations',
      label: 'Connect GoodVibes to external apps and services',
      selected: hasExternalIntegrations(snapshot),
      detail: describeExternalIntegrations(snapshot),
    },
    {
      id: 'cloudflare-batch',
      label: 'Use Cloudflare for batch or remote daemon work',
      selected: hasCloudflareBatch(snapshot),
      detail: describeCloudflareBatch(snapshot),
    },
  ];
}

export function deriveStep1CapabilityFlags(snapshot: OnboardingSnapshotState): {
  readonly providers: boolean;
  readonly services: boolean;
  readonly subscriptions: boolean;
  readonly auth: boolean;
  readonly controlPlane: boolean;
  readonly httpListener: boolean;
  readonly web: boolean;
  readonly surfaces: boolean;
  readonly cloudflare: boolean;
} {
  const access = onboardingAccessSignals(snapshot);
  return {
    providers: access.providers,
    services: snapshot.services.total > 0,
    subscriptions: access.subscriptions,
    auth: access.auth,
    controlPlane: snapshot.bindSettings.daemonEnabled || snapshot.bindSettings.controlPlane.enabled,
    httpListener: snapshot.bindSettings.httpListenerEnabled,
    web: snapshot.bindSettings.web.enabled,
    surfaces: countConfiguredSurfaceKinds(snapshot) > 0,
    cloudflare: hasCloudflareBatch(snapshot),
  };
}

export function deriveStep1_5NetworkMode(
  bindSettings: Pick<OnboardingSnapshotState, 'bindSettings'>['bindSettings'],
): OnboardingNetworkMode {
  const activeModes: string[] = [];
  const hasNetworkFacingSurface = bindSettings.httpListenerEnabled || bindSettings.web.enabled;

  if (
    (bindSettings.daemonEnabled || bindSettings.controlPlane.enabled) &&
    (!hasNetworkFacingSurface || bindSettings.controlPlane.hostMode !== 'local')
  ) {
    activeModes.push(bindSettings.controlPlane.hostMode);
  }

  if (bindSettings.httpListenerEnabled) {
    activeModes.push(bindSettings.httpListener.hostMode);
  }

  if (bindSettings.web.enabled) {
    activeModes.push(bindSettings.web.hostMode);
  }

  return activeModes.some((mode) => mode !== 'network') ? 'custom' : 'local-network-default';
}

export function deriveReopenEditAcknowledgementState(snapshot: OnboardingSnapshotState): OnboardingReopenEditAcknowledgementState {
  return deriveAcknowledgements(snapshot, {
    bootstrap: 'The local auth bootstrap credential file is still present.',
    sessions: (count) => `${count} local auth session(s) are currently active.`,
    users: (count) => `${count} local auth user(s) are already configured.`,
    empty: 'No local auth state needs confirmation.',
  });
}

export function deriveOnboardingStepState(snapshot: OnboardingSnapshotState): OnboardingStepDerivationState {
  return deriveOnboardingState(snapshot, {
    capabilities: deriveStep1Capabilities,
    network: (current) => deriveStep1_5NetworkMode(current.bindSettings),
    acknowledgements: deriveReopenEditAcknowledgementState,
  });
}

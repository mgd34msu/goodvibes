import { countPermissionToolOverrides, hasCustomizedProviderRouting, getProviderAccountSignalIds, getServiceCredentialProviderIds, getSecretBackedProviderIds, getConfiguredProviderSignalIds, hasConfiguredProviderState, getConfiguredSurfaceKinds, countConfiguredSurfaceKinds, hasInboundEventSurface, hasCustomizedWorkspaceDefaults, getProviderIdentityIds, getExternalIntegrationServiceIds, hasExternalIntegrations, getAcknowledgementAccepted, buildNotNeededAcknowledgement, buildRequiredAcknowledgement } from '@goodvibes-jev/engine/terminal-shell/onboarding-signals';
import { isDeepEqual } from '@goodvibes-jev/engine/terminal-shell/onboarding-values';
import { DEFAULT_CONFIG } from '../../config/index.ts';
import { getProviderIdFromModel } from '../../config/provider-model.ts';
import type {
  OnboardingAcknowledgementState,
  OnboardingAcknowledgementTarget,
  OnboardingNetworkMode,
  OnboardingReopenEditAcknowledgementState,
  OnboardingSnapshotState,
  OnboardingStep1CapabilityFlags,
  OnboardingStep1CapabilityItem,
  OnboardingStepDerivationState,
} from './types.ts';































function hasWebhookOrEventIngress(snapshot: OnboardingSnapshotState): boolean {
  return hasInboundEventSurface(snapshot)
    || snapshot.services.services.some((service) => service.hasWebhookUrl || service.hasSigningSecret || service.hasPublicKey || service.hasAppToken);
}







function hasLocalBehaviorCustomization(snapshot: OnboardingSnapshotState): boolean {
  return hasCustomizedWorkspaceDefaults(snapshot)
    || countPermissionToolOverrides(snapshot) > 0
    || snapshot.runtimeDefaults.secretStoragePolicy !== DEFAULT_CONFIG.storage.secretPolicy
    || countDiscoveredLocalBehavior(snapshot) > 0;
}

function hasCommunicationChannelSignals(snapshot: OnboardingSnapshotState): boolean {
  return hasExternalIntegrations(snapshot);
}

function hasAutomationReviewSignals(snapshot: OnboardingSnapshotState): boolean {
  return hasWebhookOrEventIngress(snapshot);
}

function describeOperatorTerminal(): string {
  return 'Use GoodVibes Agent as the terminal operator while connecting to an existing GoodVibes host. Agent setup does not create new entrypoints.';
}

function describeProviderAccess(snapshot: OnboardingSnapshotState): string {
  const configuredCount = getConfiguredProviderSignalIds(snapshot).length;
  if (configuredCount === 0 && !hasCustomizedProviderRouting(snapshot)) {
    return 'Choose the model route the Agent should use for normal assistant turns, tool reasoning, and embeddings.';
  }

  return `Review ${Math.max(configuredCount, 1)} provider auth or routing signal(s) already available to Agent.`;
}

function describeAgentKnowledge(): string {
  return 'Agent Knowledge uses the isolated /api/goodvibes-agent/knowledge segment only; it never falls back to another knowledge segment.';
}

function describeLocalBehavior(snapshot: OnboardingSnapshotState): string {
  const discoveredCount = countDiscoveredLocalBehavior(snapshot);
  if (discoveredCount > 0) {
    const discovery = snapshot.localBehaviorDiscovery;
    const samples = [
      ...discovery.personas.names,
      ...discovery.skills.names,
      ...discovery.routines.names,
    ].slice(0, 4);
    const sampleText = samples.length > 0 ? ` Found: ${samples.join(', ')}.` : '';
    return `Import ${discoveredCount} discovered Agent persona/skill/routine file(s) from Agent-local folders before creating blank behavior.${sampleText}`;
  }

  if (!hasLocalBehaviorCustomization(snapshot)) {
    return 'Configure local memory, routines, skills, personas, permissions, and secret handling before the Agent starts doing useful work.';
  }

  return 'Review existing local behavior, permission, display, or secret-handling choices before applying Agent setup.';
}

function countDiscoveredLocalBehavior(snapshot: OnboardingSnapshotState): number {
  return snapshot.localBehaviorDiscovery.personas.count
    + snapshot.localBehaviorDiscovery.skills.count
    + snapshot.localBehaviorDiscovery.routines.count;
}

function describeCommunicationChannels(snapshot: OnboardingSnapshotState): string {
  const integrationCount = new Set<string>([
    ...getExternalIntegrationServiceIds(snapshot),
    ...getConfiguredSurfaceKinds(snapshot),
  ]).size;

  if (integrationCount === 0) {
    return 'Connect only the channels the Agent should use, and keep outbound delivery explicit until a user action allows it.';
  }

  return `Review ${integrationCount} configured channel or integration signal(s) before the Agent uses them for delivery.`;
}

function describeAutomationReview(snapshot: OnboardingSnapshotState): string {
  if (!hasAutomationReviewSignals(snapshot)) {
    return 'Review schedules, routine promotion, approvals, and automation visibility without starting hidden background work.';
  }

  return 'Review existing event, schedule, or automation signals and keep all side effects behind explicit commands or confirmations.';
}

function describeTuiDelegation(): string {
  return 'Delegate explicit build, fix, implementation, and review work to GoodVibes TUI; delegated review is requested only when the user explicitly asks for it.';
}







export function deriveStep1Capabilities(
  snapshot: OnboardingSnapshotState,
): readonly OnboardingStep1CapabilityItem[] {
  return [
    {
      id: 'operator-terminal',
      label: 'Agent Operator TUI',
      selected: true,
      detail: describeOperatorTerminal(),
    },
    {
      id: 'provider-access',
      label: 'Provider and Model Access',
      selected: hasConfiguredProviderState(snapshot) || hasCustomizedProviderRouting(snapshot),
      detail: describeProviderAccess(snapshot),
    },
    {
      id: 'agent-knowledge',
      label: 'Isolated Agent Knowledge',
      selected: true,
      detail: describeAgentKnowledge(),
    },
    {
      id: 'local-behavior',
      label: 'Local Memory and Skills',
      selected: hasLocalBehaviorCustomization(snapshot),
      detail: describeLocalBehavior(snapshot),
    },
    {
      id: 'communication-channels',
      label: 'Channels and Notifications',
      selected: hasCommunicationChannelSignals(snapshot),
      detail: describeCommunicationChannels(snapshot),
    },
    {
      id: 'automation-review',
      label: 'Routines and Automation Review',
      selected: hasAutomationReviewSignals(snapshot),
      detail: describeAutomationReview(snapshot),
    },
    {
      id: 'tui-delegation',
      label: 'Explicit Build Delegation',
      selected: true,
      detail: describeTuiDelegation(),
    },
  ];
}

export function deriveStep1CapabilityFlags(
  snapshot: OnboardingSnapshotState,
): OnboardingStep1CapabilityFlags {
  return {
    providerAccess: hasConfiguredProviderState(snapshot) || hasCustomizedProviderRouting(snapshot),
    subscriptions: snapshot.subscriptions.active.length > 0 || snapshot.subscriptions.pending.length > 0,
    auth: snapshot.auth.snapshot.userCount > 0
      || snapshot.auth.snapshot.sessionCount > 0
      || snapshot.auth.snapshot.bootstrapCredentialPresent,
    agentKnowledge: true,
    localBehavior: hasLocalBehaviorCustomization(snapshot),
    communicationChannels: hasCommunicationChannelSignals(snapshot),
    automationReview: hasAutomationReviewSignals(snapshot),
    tuiDelegation: true,
  };
}

export function deriveStep1_5NetworkMode(): OnboardingNetworkMode {
  return 'local-network-default';
}

export function deriveReopenEditAcknowledgementState(
  snapshot: OnboardingSnapshotState,
): OnboardingReopenEditAcknowledgementState {
  const providerAccounts = snapshot.providerAccounts?.providers ?? [];
  const providerPendingCount = providerAccounts.filter((provider) => provider.pendingLogin).length;
  const providerConfiguredCount = providerAccounts.filter((provider) => provider.activeRoute !== 'unconfigured' || provider.oauthReady).length;
  const providerRoutingCustomized = hasCustomizedProviderRouting(snapshot);
  const providerSignalCount = getConfiguredProviderSignalIds(snapshot).length;

  const subscriptionsPendingCount = snapshot.subscriptions.pending.length;
  const subscriptionsActiveCount = snapshot.subscriptions.active.length;

  const authUserCount = snapshot.auth.snapshot.userCount;
  const authSessionCount = snapshot.auth.snapshot.sessionCount;
  const bootstrapCredentialPresent = snapshot.auth.snapshot.bootstrapCredentialPresent;

  const providers = providerPendingCount > 0
    ? buildRequiredAcknowledgement(
        snapshot,
        'providers',
        'pending-login',
        `${providerPendingCount} provider login(s) are still pending completion.`,
      )
    : providerConfiguredCount > 0 || providerSignalCount > 0
      ? buildRequiredAcknowledgement(
          snapshot,
          'providers',
          'configured-routing',
          `${Math.max(providerConfiguredCount, providerSignalCount, 1)} provider auth path(s) are already configured.`,
        )
      : providerRoutingCustomized
        ? buildRequiredAcknowledgement(
            snapshot,
            'providers',
            'customized-config',
            'Provider routing already differs from the default shell configuration.',
          )
        : buildNotNeededAcknowledgement(snapshot, 'providers', 'No existing provider routing needs confirmation.');

  const subscriptions = subscriptionsPendingCount > 0
    ? buildRequiredAcknowledgement(
        snapshot,
        'subscriptions',
        'pending-login',
        `${subscriptionsPendingCount} subscription login(s) are pending completion.`,
      )
    : subscriptionsActiveCount > 0
      ? buildRequiredAcknowledgement(
          snapshot,
          'subscriptions',
          'subscription-state',
          `${subscriptionsActiveCount} stored subscription session(s) already exist.`,
        )
      : buildNotNeededAcknowledgement(snapshot, 'subscriptions', 'No stored subscription sessions need confirmation.');

  const auth = bootstrapCredentialPresent
    ? buildRequiredAcknowledgement(
        snapshot,
        'auth',
        'bootstrap-credential',
        'A connected-host bootstrap credential signal is still visible to Agent.',
      )
    : authSessionCount > 0
      ? buildRequiredAcknowledgement(
          snapshot,
          'auth',
          'active-sessions',
          `${authSessionCount} connected-host auth session signal(s) are currently visible.`,
        )
      : authUserCount > 0
        ? buildRequiredAcknowledgement(
            snapshot,
            'auth',
            'auth-state',
            `${authUserCount} connected-host auth user signal(s) are already visible.`,
          )
        : buildNotNeededAcknowledgement(snapshot, 'auth', 'No connected-host auth signal needs confirmation.');

  return {
    providers,
    subscriptions,
    auth,
  };
}

export function deriveOnboardingStepState(
  snapshot: OnboardingSnapshotState,
): OnboardingStepDerivationState {
  return {
    step1Capabilities: deriveStep1Capabilities(snapshot),
    step1_5NetworkMode: deriveStep1_5NetworkMode(),
    reopenEditAcknowledgements: deriveReopenEditAcknowledgementState(snapshot),
  };
}

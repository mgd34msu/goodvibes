import { getSubscriptionProviderConfig } from '@goodvibes-jev/engine/platform/platform/config';
import type { OAuthProviderConfig, ProviderSubscription } from '@goodvibes-jev/engine/platform/platform/config';
import { readAuthorizationInput } from '@goodvibes-jev/engine/terminal-shell/settings-subscriptions';
import { openExternalUrl } from '@goodvibes-jev/engine/platform/platform/utils';
import type { CommandContext } from './command-registry.ts';
import { isAffirmative } from './agent-workspace-command-editor-engine.ts';
import { buildAgentWorkspaceRuntimeSnapshot } from './agent-workspace-snapshot.ts';
import type { AgentWorkspaceActionResult, AgentWorkspaceLocalEditor, AgentWorkspaceRuntimeSnapshot } from './agent-workspace-types.ts';

export interface AgentWorkspaceSubscriptionEditorHost {
  localEditor: AgentWorkspaceLocalEditor | null;
  runtimeSnapshot: AgentWorkspaceRuntimeSnapshot | null;
  status: string;
  lastActionResult: AgentWorkspaceActionResult | null;
  clampSelection(): void;
  /**
   * Called after a successful sign-in so the host can refresh onboarding state
   * and navigate to the next onboarding step (e.g. account-model). Optional,
   * only available when running in ONBOARDING mode.
   */
  onSubscriptionLoginSuccess?(): void;
}

export type AgentWorkspaceSubscriptionFieldReader = (id: string) => string;

// Login start and finish are single-use against the provider. A second Enter while one is running
// is refused by the one in-flight guard every direct form shares (agent-workspace-direct-editor-submission.ts).

/** The submitted form is still the open one, so its result may close or reopen it. */
function isFormStillOpen(host: AgentWorkspaceSubscriptionEditorHost, editor: AgentWorkspaceLocalEditor): boolean {
  return host.localEditor?.kind === editor.kind;
}

function reportLoginFailure(
  host: AgentWorkspaceSubscriptionEditorHost,
  editor: AgentWorkspaceLocalEditor,
  title: string,
  error: unknown,
): void {
  const detail = error instanceof Error ? error.message : String(error);
  // Keep what the user has typed since submitting; leave another editor they opened alone.
  if (host.localEditor && isFormStillOpen(host, editor)) host.localEditor = { ...host.localEditor, message: detail };
  host.status = detail;
  host.lastActionResult = { kind: 'error', title, detail, safety: 'safe' };
}

export async function submitAgentWorkspaceSubscriptionLoginStartEditor(
  host: AgentWorkspaceSubscriptionEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: AgentWorkspaceSubscriptionFieldReader,
): Promise<void> {
  if (!isAffirmative(readField('confirm'))) {
    host.localEditor = { ...editor, message: 'Subscription login start not confirmed. Type yes, then press Enter.' };
    host.status = 'Subscription login start not confirmed.';
    return;
  }
  try {
    const provider = readField('provider') || 'openai';
    const openBrowser = isAffirmative(readField('openBrowser'));
    const { manager, services } = subscriptionServices(context);
    const resolved = getSubscriptionProviderConfig(provider, services.get(provider));
    if (!resolved) {
      throw new Error(`OAuth is not configured for ${provider}. Add an OAuth provider service or choose a built-in subscription provider.`);
    }

    const { authorizationUrl } = await manager.beginOAuthLogin(provider, resolveManualLoginConfig(resolved.oauth));

    const browserOpened = openBrowser ? await openExternalUrl(authorizationUrl) : false;
    if (isFormStillOpen(host, editor)) host.localEditor = null;
    host.runtimeSnapshot = context ? buildAgentWorkspaceRuntimeSnapshot(context) : host.runtimeSnapshot;
    host.status = `Subscription login started for ${provider}.`;
    host.lastActionResult = {
      kind: 'refreshed',
      title: 'Subscription login started',
      detail: [
        `Provider: ${provider}.`,
        `Browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}.`,
        'Use Finish subscription login with the callback code or redirect URL.',
        `Authorization URL: ${authorizationUrl}`,
      ].join(' '),
      safety: 'safe',
    };
    host.clampSelection();
  } catch (error) {
    reportLoginFailure(host, editor, 'Subscription login start failed', error);
  }
}

export async function submitAgentWorkspaceSubscriptionLoginFinishEditor(
  host: AgentWorkspaceSubscriptionEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: AgentWorkspaceSubscriptionFieldReader,
): Promise<void> {
  if (!isAffirmative(readField('confirm'))) {
    host.localEditor = { ...editor, message: 'Subscription login finish not confirmed. Type yes, then press Enter.' };
    host.status = 'Subscription login finish not confirmed.';
    return;
  }
  let saved: ProviderSubscription | null = null;
  try {
    const provider = readField('provider') || 'openai';
    const codeInput = readField('code');
    const { manager, services } = subscriptionServices(context);
    const authorization = readAuthorizationInput(codeInput, manager.getPending(provider)?.state);
    if (!authorization.ok) throw new Error(authorization.reason);
    const code = authorization.code;
    const resolved = getSubscriptionProviderConfig(provider, services.get(provider));
    if (!resolved) {
      throw new Error(`OAuth is not configured for ${provider}. Start with a configured or built-in subscription provider.`);
    }

    saved = await manager.completeOAuthLogin(provider, resolveManualLoginConfig(resolved.oauth), code);
    if (isFormStillOpen(host, editor)) host.localEditor = null;
    host.runtimeSnapshot = context ? buildAgentWorkspaceRuntimeSnapshot(context) : host.runtimeSnapshot;
    host.status = `Subscription session saved for ${provider}.`;
    host.lastActionResult = {
      kind: 'refreshed',
      title: 'Subscription session saved',
      detail: [
        `Provider: ${provider}.`,
        `Token type: ${saved.tokenType}.`,
        `Expires: ${saved.expiresAt ? new Date(saved.expiresAt).toISOString() : 'n/a'}.`,
        describeSubscriptionPrecedence(saved),
      ].join(' '),
      safety: 'safe',
    };
    host.clampSelection();
  } catch (error) {
    reportLoginFailure(host, editor, 'Subscription login finish failed', error);
  }
  // The session is saved by now. A failing follow-up must not turn that into a "login failed" report.
  if (saved) {
    try {
      host.onSubscriptionLoginSuccess?.();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      host.status = `Subscription session saved, but the follow-up step failed: ${detail}`;
    }
  }
}

export async function submitAgentWorkspaceSubscriptionLogoutEditor(
  host: AgentWorkspaceSubscriptionEditorHost,
  editor: AgentWorkspaceLocalEditor,
  context: CommandContext | null,
  readField: AgentWorkspaceSubscriptionFieldReader,
): Promise<void> {
  if (!isAffirmative(readField('confirm'))) {
    host.localEditor = { ...editor, message: 'Subscription logout not confirmed. Type yes, then press Enter.' };
    host.status = 'Subscription logout not confirmed.';
    return;
  }
  try {
    const provider = readField('provider') || 'openai';
    const { manager } = subscriptionServices(context);
    const removed = await manager.logout(provider);
    host.localEditor = null;
    host.runtimeSnapshot = context ? buildAgentWorkspaceRuntimeSnapshot(context) : host.runtimeSnapshot;
    host.status = removed ? `Logged out of ${provider}.` : `No subscription session existed for ${provider}.`;
    host.lastActionResult = {
      kind: removed ? 'refreshed' : 'guidance',
      title: removed ? 'Subscription session removed' : 'No subscription session found',
      detail: removed
        ? `Removed active or pending subscription state for ${provider}. Ambient API key resolution applies if configured.`
        : `No active or pending subscription state existed for ${provider}.`,
      safety: 'safe',
    };
    host.clampSelection();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    host.localEditor = { ...editor, message: detail };
    host.status = detail;
    host.lastActionResult = { kind: 'error', title: 'Subscription logout failed', detail, safety: 'safe' };
  }
}

function subscriptionServices(context: CommandContext | null) {
  const manager = context?.platform.subscriptionManager;
  const services = context?.platform.serviceRegistry;
  if (!manager || !services) throw new Error('Subscription services are unavailable in this runtime.');
  return { manager, services };
}

function resolveManualLoginConfig(config: OAuthProviderConfig): OAuthProviderConfig {
  return config.manualRedirectUri
    ? { ...config, redirectUri: config.manualRedirectUri }
    : config;
}

function describeSubscriptionPrecedence(record: Pick<ProviderSubscription, 'overrideAmbientApiKeys'>): string {
  return record.overrideAmbientApiKeys
    ? 'Subscription routing now overrides ambient API keys for this provider.'
    : 'Subscription session is stored for subscription-backed flows; ambient API keys are unchanged.';
}

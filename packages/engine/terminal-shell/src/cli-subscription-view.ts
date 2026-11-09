import { yesNo, formatJsonOrText } from './cli-output.js';
import {
  getSubscriptionProviderConfig,
  listAvailableSubscriptionProviders,
  beginOpenAICodexLogin,
  exchangeOpenAICodexCode,
  type SubscriptionManager,
  type ServiceRegistry,
  type SecretsManager,
  type OAuthProviderConfig,
} from '@goodvibes-jev/engine/platform/platform/config';
import { inspectProviderAuth } from '@goodvibes-jev/engine/platform/platform/runtime/security';
import { extractAuthorizationCode, hasCommandFlag } from './cli-arguments.js';
import { openBrowser } from './cli-environment.js';

interface SubscriptionRuntime {
  readonly cli: {
    readonly commandArgs: readonly string[];
    readonly flags: { readonly outputFormat?: string | undefined; readonly open?: boolean | undefined };
  };
}
interface SubscriptionServices {
  readonly subscriptionManager: SubscriptionManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: SecretsManager;
}

/** CLI subscription actions share their OAuth/state mechanics; explicit manual completion remains a product policy. */
export function createCliSubscriptionView<Runtime extends SubscriptionRuntime, Services extends SubscriptionServices>(
  withRuntimeServices: <T>(runtime: Runtime, fn: (services: Services) => Promise<T> | T) => Promise<T>,
  policy: {
    readonly inline: boolean;
    readonly manualOnly: boolean;
    readonly binary: (runtime: Runtime) => string;
    readonly source: (source: string) => string;
    readonly time: (timestamp: number) => string;
  },
) {
  const separator = policy.inline ? ': ' : ' ';
  const labels: Readonly<Record<string, string>> = {
    configured: 'configured',
    freshness: 'freshness',
    source: 'origin',
    redirectUri: 'redirect URI',
    tokenType: 'token type',
    expiresAt: 'expires',
    refreshToken: 'refresh token',
    overrideAmbient: 'override ambient',
    stored: 'stored',
    issue: 'issue',
    next: 'next',
    state: 'state',
    open: 'open',
  };
  const field = (key: string, value: string): string => '  ' + (policy.inline ? key : (labels[key] ?? key)) + separator + value;
  const oauthForSurface = (config: OAuthProviderConfig): OAuthProviderConfig =>
    policy.manualOnly && config.manualRedirectUri ? { ...config, redirectUri: config.manualRedirectUri } : config;
  const storedReceipt = (provider: string, record: NonNullable<ReturnType<SubscriptionManager['get']>>): string =>
    policy.inline
      ? 'Subscription stored: ' +
        provider +
        ' token=' +
        record.tokenType +
        ' expires=' +
        (record.expiresAt ? policy.time(record.expiresAt) : 'n/a')
      : [
          'Subscription stored ' + provider,
          field('tokenType', record.tokenType),
          field('expiresAt', record.expiresAt ? policy.time(record.expiresAt) : 'n/a'),
        ].join('\n');
  async function renderSubscriptions(runtime: Runtime): Promise<string> {
    return await withRuntimeServices(runtime, async (services) => {
      const [sub = 'list', ...rest] = runtime.cli.commandArgs;
      const subscriptions = services.subscriptionManager.list();
      const pending = services.subscriptionManager.listPending();
      const available = listAvailableSubscriptionProviders(services.serviceRegistry.getAll());
      if (sub === 'providers') {
        return formatJsonOrText(runtime.cli)(
          available,
          [
            'GoodVibes subscription providers',
            ...available.map((provider) =>
              policy.inline
                ? `  ${provider.provider} source=${provider.source} redirect=${provider.oauth.redirectUri}`
                : `  ${provider.provider}  origin ${provider.source}  redirect ${provider.oauth.redirectUri}`,
            ),
          ].join('\n'),
        );
      }
      if (sub === 'inspect' || sub === 'show') {
        const provider = rest[0];
        if (!provider) return `Usage: ${policy.binary(runtime)} subscription inspect <provider>`;
        const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
        if (!resolved && !services.subscriptionManager.get(provider) && !services.subscriptionManager.getPending(provider)) {
          return `No stored or available subscription provider named ${provider}.`;
        }
        const inspection = await inspectProviderAuth(provider, {
          serviceRegistry: services.serviceRegistry,
          subscriptionManager: services.subscriptionManager,
          secretsManager: services.secretsManager,
        });
        const stored = services.subscriptionManager.get(provider);
        return formatJsonOrText(runtime.cli)(
          { provider, resolved, inspection, stored },
          [
            `GoodVibes subscription ${provider}`,
            field('configured', String(yesNo(inspection.configured))),
            field('freshness', String(inspection.freshness)),
            policy.manualOnly ? '  finish mode explicit manual' : field('callbackMode', inspection.callbackMode),
            ...(resolved
              ? [field('source', policy.source(resolved.source)), field('redirectUri', String(resolved.oauth.redirectUri))]
              : []),
            ...(stored
              ? [
                  field('tokenType', String(stored.tokenType)),
                  field('expiresAt', String(stored.expiresAt ? policy.time(stored.expiresAt) : 'n/a')),
                  field('refreshToken', String(stored.refreshToken ? 'present' : 'absent')),
                  field('overrideAmbient', String(yesNo(stored.overrideAmbientApiKeys))),
                ]
              : [field('stored', 'no')]),
            ...inspection.issues.map((issue) => field('issue', String(issue))),
            ...inspection.nextActions.map((action) => field('next', String(action))),
          ].join('\n'),
        );
      }
      if (sub === 'login' || sub === 'start') {
        const provider = sub === 'start' ? rest[0] : rest[0];
        const mode = sub === 'start' ? 'start' : rest[1]?.toLowerCase();
        if (!provider || mode !== 'start') return `Usage: ${policy.binary(runtime)} subscription login <provider> start [--open]`;
        const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
        if (!resolved) return `No subscription provider found${separator}${provider}`;
        if (provider === 'openai' && resolved.source === 'builtin') {
          const started = await beginOpenAICodexLogin();
          services.subscriptionManager.savePending({
            provider,
            state: started.state,
            verifier: started.verifier,
            redirectUri: started.redirectUri,
            createdAt: Date.now(),
          });
          const openResult = runtime.cli.flags.open || hasCommandFlag(rest, '--open') ? openBrowser(started.authorizationUrl) : null;
          return [
            `Subscription OAuth started${separator}${provider}`,
            field('source', policy.source(resolved.source)),
            field('state', String(started.state)),
            field('redirectUri', String(started.redirectUri)),
            ...(openResult ? [field('open', String(openResult))] : []),
            ...(policy.manualOnly ? ['  completion paste the callback code or redirect URL into the finish command'] : []),
            `  next${separator}${policy.binary(runtime)} subscription login ${provider} finish <code-or-url>`,
            policy.inline ? '  authorizationUrl:' : '  authorization URL',
            `  ${started.authorizationUrl}`,
          ].join('\n');
        }
        const started = await services.subscriptionManager.beginOAuthLogin(provider, oauthForSurface(resolved.oauth));
        const openResult = runtime.cli.flags.open || hasCommandFlag(rest, '--open') ? openBrowser(started.authorizationUrl) : null;
        return [
          `Subscription OAuth started${separator}${provider}`,
          field('source', policy.source(resolved.source)),
          field('state', String(started.pending.state)),
          field('redirectUri', String(started.pending.redirectUri)),
          ...(openResult ? [field('open', String(openResult))] : []),
          ...(policy.manualOnly ? ['  completion paste the callback code or redirect URL into the finish command'] : []),
          `  next${separator}${policy.binary(runtime)} subscription login ${provider} finish <code-or-url>`,
          policy.inline ? '  authorizationUrl:' : '  authorization URL',
          `  ${started.authorizationUrl}`,
        ].join('\n');
      }
      if (sub === 'finish' || (sub === 'login' && rest[1]?.toLowerCase() === 'finish')) {
        const provider = sub === 'finish' ? rest[0] : rest[0];
        const codeInput = sub === 'finish' ? rest[1] : rest[2];
        if (!provider || !codeInput) return `Usage: ${policy.binary(runtime)} subscription login <provider> finish <code-or-url>`;
        const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
        if (!resolved) return `No subscription provider found: ${provider}`;
        const code = extractAuthorizationCode(codeInput);
        if (provider === 'openai' && resolved.source === 'builtin') {
          const pendingLogin = services.subscriptionManager.getPending(provider);
          if (!pendingLogin) return `No pending OAuth login for ${provider}.`;
          const token = await exchangeOpenAICodexCode(code, pendingLogin.verifier);
          const now = Date.now();
          const record = services.subscriptionManager.saveSubscription({
            provider,
            accessToken: token.accessToken,
            refreshToken: token.refreshToken,
            tokenType: token.tokenType,
            expiresAt: token.expiresAt,
            ...(token.scopes ? { scopes: token.scopes } : {}),
            authMode: 'oauth',
            overrideAmbientApiKeys: false,
            createdAt: services.subscriptionManager.get(provider)?.createdAt ?? now,
            updatedAt: now,
          });
          return storedReceipt(provider, record);
        }
        const record = await services.subscriptionManager.completeOAuthLogin(provider, oauthForSurface(resolved.oauth), code);
        return storedReceipt(provider, record);
      }
      if (sub === 'refresh') {
        const provider = rest[0];
        if (!provider) return `Usage: ${policy.binary(runtime)} subscription refresh <provider>`;
        const resolved = getSubscriptionProviderConfig(provider, services.serviceRegistry.get(provider));
        if (!resolved) return `No subscription provider found: ${provider}`;
        const record = await services.subscriptionManager.refreshOAuthToken(provider, resolved.oauth);
        return policy.inline
          ? `Subscription refreshed: ${provider} expires=${record.expiresAt ? policy.time(record.expiresAt) : 'n/a'}`
          : ['Subscription refreshed ' + provider, field('expiresAt', record.expiresAt ? policy.time(record.expiresAt) : 'n/a')].join('\n');
      }
      if (sub === 'logout' || sub === 'remove') {
        const provider = rest[0];
        if (!provider) return `Usage: ${policy.binary(runtime)} subscription logout <provider>`;
        const removed = services.subscriptionManager.logout(provider);
        return removed ? `Subscription removed${separator}${provider}` : `No stored subscription session existed for ${provider}.`;
      }
      if (sub !== 'list' && sub !== 'status' && sub !== 'review') {
        return `Usage: ${policy.binary(runtime)} subscription [list|providers|inspect <provider>|login <provider> start|finish <code-or-url>|refresh <provider>|logout <provider>]`;
      }
      const value = {
        subscriptions: subscriptions.map((sub) => ({
          provider: sub.provider,
          tokenType: sub.tokenType,
          expiresAt: sub.expiresAt ?? null,
          overrideAmbientApiKeys: sub.overrideAmbientApiKeys,
        })),
        pending: pending.map((sub) => ({ provider: sub.provider, createdAt: sub.createdAt })),
      };
      return formatJsonOrText(runtime.cli)(
        value,
        [
          'GoodVibes subscriptions',
          subscriptions.length === 0 ? field('active', 'none') : '  active' + (policy.inline ? ':' : ''),
          ...subscriptions.map(
            (sub) =>
              `    ${sub.provider} token${policy.inline ? '=' : ' '}${sub.tokenType} expires${policy.inline ? '=' : ' '}${sub.expiresAt ? policy.time(sub.expiresAt) : 'n/a'} ${policy.inline ? 'overrideAmbient=' : 'override ambient '}${yesNo(sub.overrideAmbientApiKeys)}`,
          ),
          pending.length === 0 ? field('pending', 'none') : '  pending' + (policy.inline ? ':' : ''),
          ...pending.map((sub) => `    ${sub.provider} created${policy.inline ? '=' : ' '}${policy.time(sub.createdAt)}`),
        ].join('\n'),
      );
    });
  }
  return { renderSubscriptions };
}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createOAuthLocalListener,
  beginOpenAICodexLogin,
  exchangeOpenAICodexCode,
  getSubscriptionProviderConfig,
  listAvailableSubscriptionProviders,
  type OAuthProviderConfig,
  type ProviderSubscription,
  type SubscriptionManager,
} from '@goodvibes-jev/engine/sdk/platform/config';
import { inspectProviderAuth } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { openExternalUrl, summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { ShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import type { TerminalCommandRegistry } from './command-registry.js';
import { extractAuthorizationCode } from './settings-subscriptions.js';
import { requireYesFlag, stripYesFlag, type CommandConfirmationContext } from './command-confirmation.js';
export interface SubscriptionCommandContext extends CommandConfirmationContext {
  readonly openModal?: ((name: string) => void) | undefined;
}
export function createSubscriptionRuntimeCommands<Context extends SubscriptionCommandContext>(
  services: {
    readonly requireSubscriptionManager: (context: Context) => SubscriptionManager;
    readonly requireServiceRegistry: (context: Context) => NonNullable<Parameters<typeof inspectProviderAuth>[1]['serviceRegistry']>;
    readonly requireSecretsManager: (context: Context) => NonNullable<Parameters<typeof inspectProviderAuth>[1]['secretsManager']>;
    readonly requireShellPaths: (context: Context) => ShellPathService;
  },
  policy: {
    readonly hidden: boolean;
    readonly confirmMutations: boolean;
    readonly eagerPaths: boolean;
    readonly openModalOnEmpty: boolean;
    readonly manualOnly: boolean;
    readonly bundleWarning: boolean;
    readonly catchErrors: boolean;
    readonly surfaceRoot: string;
    readonly formatSource: (source: string) => string;
    readonly error: (error: unknown) => string;
    readonly present: (message: string) => string;
  },
) {
  const { requireSubscriptionManager, requireServiceRegistry, requireSecretsManager, requireShellPaths } = services;
  interface SubscriptionBundle {
    readonly version: 1;
    readonly exportedAt: number;
    readonly subscriptions: readonly ProviderSubscription[];
  }
  function buildReviewText(ctx: Context): string {
    const subscriptions = requireSubscriptionManager(ctx).list();
    const available = listAvailableSubscriptionProviders(requireServiceRegistry(ctx).getAll());
    if (subscriptions.length === 0) {
      return [
        'Subscription Review',
        '  No provider subscriptions stored yet.',
        ...(available.length > 0 ? [`  available providers: ${available.map((entry) => entry.provider).join(', ')}`] : []),
      ].join('\n');
    }
    return [
      `Subscription Review`,
      ...subscriptions.map(
        (subscription) =>
          `  ${subscription.provider}  ${subscription.authMode}  token=${subscription.tokenType}  expires=${subscription.expiresAt ? new Date(subscription.expiresAt).toISOString() : 'n/a'}`,
      ),
    ].join('\n');
  }
  function inspectBundle(path: string): string {
    const bundle = JSON.parse(readFileSync(path, 'utf-8')) as SubscriptionBundle;
    return [
      'Subscription Bundle Review',
      `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
      `  subscriptions: ${bundle.subscriptions.length}`,
      ...bundle.subscriptions.map((subscription) => `  ${subscription.provider}  ${subscription.authMode}`),
    ].join('\n');
  }
  function resolveLoginConfig(config: OAuthProviderConfig, useLocalCallback: boolean): OAuthProviderConfig {
    if (!useLocalCallback || !config.localCallback) {
      return config.manualRedirectUri ? { ...config, redirectUri: config.manualRedirectUri } : config;
    }
    return config;
  }
  function describePrecedence(record: Pick<ProviderSubscription, 'overrideAmbientApiKeys'>): string {
    return record.overrideAmbientApiKeys
      ? '  precedence: this now overrides ambient API keys for the provider'
      : '  precedence: stored for subscription-backed flows only; ambient API keys are unchanged';
  }
  function registerSubscriptionRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    registry.register({
      name: 'subscription',
      aliases: ['subs'],
      description: 'Manage provider subscription sessions and, when supported, let them override ambient API keys for matching providers',
      usage:
        '[review|list|providers|inspect <provider>|login <provider> start [--no-browser] [--manual]|finish <code-or-url>|logout <provider>|bundle export <path>|bundle inspect <path>]',
      ...(policy.hidden ? { hidden: true } : {}),
      async handler(args, ctx) {
        const parsed = policy.confirmMutations ? stripYesFlag(args) : { rest: args, yes: true };
        args = [...parsed.rest];
        const print = (message: string) => ctx.print(policy.present(message));
        const shellPaths = policy.eagerPaths ? requireShellPaths(ctx) : undefined;
        if (policy.openModalOnEmpty && args.length === 0 && ctx.openModal) {
          ctx.openModal('subscription-modal'); // subscription view -> config modal
          return;
        }
        const sub = (args[0] ?? 'review').toLowerCase();
        const manager = requireSubscriptionManager(ctx);
        const services = requireServiceRegistry(ctx);
        if (sub === 'review' || sub === 'list') {
          print(buildReviewText(ctx));
          return;
        }
        if (sub === 'providers') {
          const available = listAvailableSubscriptionProviders(services.getAll());
          if (available.length === 0) {
            print('No subscription-capable providers are currently configured or built in.');
            return;
          }
          print(
            [
              'Available Subscription Providers',
              ...available.map(
                (provider) =>
                  `  ${provider.provider}  source=${policy.formatSource(provider.source)}  redirect=${provider.oauth.redirectUri}`,
              ),
            ].join('\n'),
          );
          return;
        }
        if (sub === 'inspect') {
          const provider = args[1];
          if (!provider) {
            print('Usage: /subscription inspect <provider>');
            return;
          }
          const resolved = getSubscriptionProviderConfig(provider, services.get(provider));
          if (!resolved && !manager.get(provider) && !manager.getPending(provider)) {
            print(`No stored or available subscription provider named ${provider}.`);
            return;
          }
          let inspection;
          try {
            inspection = await inspectProviderAuth(provider, {
              serviceRegistry: services,
              subscriptionManager: manager,
              secretsManager: requireSecretsManager(ctx),
            });
          } catch (error) {
            if (!policy.catchErrors) throw error;
            print(`Could not inspect provider auth for ${provider}: ${policy.error(error)}`);
            return;
          }
          print(
            [
              `Subscription ${provider}`,
              `  configured: ${inspection.configured ? 'yes' : 'no'}`,
              `  freshness: ${inspection.freshness}`,
              policy.manualOnly ? '  finish mode explicit manual' : `  callbackMode: ${inspection.callbackMode}`,
              ...(resolved
                ? [
                    `  source: ${policy.formatSource(resolved.source)}`,
                    `  redirectUri: ${resolved.oauth.redirectUri}`,
                    `  authUrl: ${resolved.oauth.authUrl}`,
                    `  tokenUrl: ${resolved.oauth.tokenUrl}`,
                    ...(!policy.manualOnly && inspection.localCallback ? [`  localCallback: ${inspection.localCallback}`] : []),
                  ]
                : []),
              ...(inspection.activeSubscription
                ? [
                    `  authMode: ${manager.get(provider)?.authMode ?? 'oauth'}`,
                    `  tokenType: ${inspection.tokenType ?? 'n/a'}`,
                    `  createdAt: ${manager.get(provider)?.createdAt ? new Date(manager.get(provider)!.createdAt).toISOString() : 'n/a'}`,
                    `  updatedAt: ${manager.get(provider)?.updatedAt ? new Date(manager.get(provider)!.updatedAt).toISOString() : 'n/a'}`,
                    `  expiresAt: ${inspection.expiresAt ? new Date(inspection.expiresAt).toISOString() : 'n/a'}`,
                    `  refreshToken: ${manager.get(provider)?.refreshToken ? 'present' : 'absent'}`,
                    describePrecedence(manager.get(provider)!),
                  ]
                : [`  state: ${inspection.freshness === 'pending' ? 'pending login' : 'available for login'}`]),
              ...inspection.issues.map((issue) => `  issue: ${issue}`),
              ...inspection.nextActions.map((action) => `  next: ${action}`),
            ].join('\n'),
          );
          return;
        }
        if (sub === 'login') {
          const provider = args[1];
          const mode = args[2]?.toLowerCase();
          if (!provider || !mode) {
            print('Usage: /subscription login <provider> start|finish <code>');
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(
              ctx,
              `${mode} provider subscription login for ${provider}`,
              '/subscription login <provider> start|finish <code> --yes',
            );
            return;
          }
          const service = services.get(provider);
          const resolved = getSubscriptionProviderConfig(provider, service);
          if (!resolved) {
            print(
              [
                `OAuth is not configured for ${provider}.`,
                `Add an oauth block to .goodvibes/${policy.surfaceRoot}/services.json for that provider, for example:`,
                `  { "name": "${provider}", "authType": "oauth", "tokenKey": "${provider.toUpperCase()}_API_KEY", "providerId": "${provider}", "oauth": { "authUrl": "...", "tokenUrl": "...", "clientId": "...", "redirectUri": "http://127.0.0.1/callback", "scopes": ["..."] } }`,
              ].join('\n'),
            );
            return;
          }
          if (mode === 'start') {
            const flags = new Set(args.slice(3));
            const openBrowser = !flags.has('--no-browser');
            const useManualMode = policy.manualOnly || flags.has('--manual');
            if (provider === 'openai' && resolved.source === 'builtin') {
              const started = await beginOpenAICodexLogin();
              manager.savePending({
                provider,
                state: started.state,
                verifier: started.verifier,
                redirectUri: started.redirectUri,
                createdAt: Date.now(),
              });
              let listener: Awaited<ReturnType<typeof createOAuthLocalListener>> | null = null;
              if (!useManualMode) {
                try {
                  listener = await createOAuthLocalListener({
                    expectedState: started.state,
                    host: '127.0.0.1',
                    port: 1455,
                    path: '/auth/callback',
                  }).catch(() => null); // best-effort: listener creation is optional; null triggers manual flow
                } catch {
                  listener = null;
                }
              }
              const browserOpened = openBrowser ? await openExternalUrl(started.authorizationUrl) : false;
              if (listener && browserOpened) {
                try {
                  const callback = await listener.waitForCode();
                  const token = await exchangeOpenAICodexCode(callback.code, started.verifier);
                  const now = Date.now();
                  const record = manager.saveSubscription({
                    provider,
                    accessToken: token.accessToken,
                    refreshToken: token.refreshToken,
                    tokenType: token.tokenType,
                    expiresAt: token.expiresAt,
                    ...(token.scopes ? { scopes: token.scopes } : {}),
                    authMode: 'oauth',
                    overrideAmbientApiKeys: false,
                    createdAt: manager.get(provider)?.createdAt ?? now,
                    updatedAt: now,
                  });
                  print(
                    [
                      `Subscription OAuth Start: ${provider}`,
                      `  source: ${policy.formatSource(resolved.source)}`,
                      `  state: ${started.state}`,
                      `  redirectUri: ${started.redirectUri}`,
                      `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
                      '  authorizationUrl:',
                      `  ${started.authorizationUrl}`,
                      `Subscription OAuth Complete: ${provider}`,
                      `  tokenType: ${record.tokenType}`,
                      `  expiresAt: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
                      describePrecedence(record),
                    ].join('\n'),
                  );
                  return;
                } catch (error) {
                  listener.close();
                  print(
                    [
                      `Subscription OAuth Start: ${provider}`,
                      `  source: ${policy.formatSource(resolved.source)}`,
                      `  state: ${started.state}`,
                      `  redirectUri: ${started.redirectUri}`,
                      `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
                      `  next: /subscription login ${provider} finish <code-or-url>`,
                      `  listener: ${summarizeError(error)}`,
                      '  authorizationUrl:',
                      `  ${started.authorizationUrl}`,
                    ].join('\n'),
                  );
                  return;
                }
              }
              listener?.close();
              print(
                [
                  `Subscription OAuth Start: ${provider}`,
                  `  source: ${policy.formatSource(resolved.source)}`,
                  `  state: ${started.state}`,
                  `  redirectUri: ${started.redirectUri}`,
                  `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
                  `  next: /subscription login ${provider} finish <code-or-url>`,
                  '  authorizationUrl:',
                  `  ${started.authorizationUrl}`,
                ].join('\n'),
              );
              return;
            }
            const useLocalCallback = Boolean(resolved.oauth.localCallback) && !useManualMode;
            let activeConfig = resolveLoginConfig(resolved.oauth, useLocalCallback);
            let listener: Awaited<ReturnType<typeof createOAuthLocalListener>> | null = null;
            if (useLocalCallback && resolved.oauth.localCallback) {
              listener = await createOAuthLocalListener({
                expectedState: '',
                host: resolved.oauth.localCallback.host,
                port: resolved.oauth.localCallback.port,
                path: resolved.oauth.localCallback.path,
              }).catch(() => null); // best-effort: local callback listener is optional; null falls back to manual redirect
            }
            if (listener) {
              activeConfig = { ...activeConfig, redirectUri: listener.redirectUri };
            }
            const started = await manager.beginOAuthLogin(provider, activeConfig);
            if (listener) {
              listener.setExpectedState(started.pending.state);
            }
            const browserOpened = openBrowser ? await openExternalUrl(started.authorizationUrl) : false;
            const shouldAutoComplete = Boolean(listener) && (resolved.oauth.localCallback?.autoComplete ?? true) && browserOpened;
            if (shouldAutoComplete && listener) {
              try {
                const callback = await listener.waitForCode();
                const record = await manager.completeOAuthLogin(provider, activeConfig, callback.code);
                print(
                  [
                    `Subscription OAuth Start: ${provider}`,
                    `  source: ${policy.formatSource(resolved.source)}`,
                    `  state: ${started.pending.state}`,
                    `  redirectUri: ${activeConfig.redirectUri}`,
                    `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
                    '  authorizationUrl:',
                    `  ${started.authorizationUrl}`,
                    `Subscription OAuth Complete: ${provider}`,
                    `  tokenType: ${record.tokenType}`,
                    `  expiresAt: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
                    describePrecedence(record),
                  ].join('\n'),
                );
                return;
              } catch (error) {
                listener.close();
                print(
                  [
                    `Subscription OAuth Start: ${provider}`,
                    `  source: ${policy.formatSource(resolved.source)}`,
                    `  state: ${started.pending.state}`,
                    `  redirectUri: ${activeConfig.redirectUri}`,
                    `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
                    `  next: /subscription login ${provider} finish <code-or-url>`,
                    `  listener: ${summarizeError(error)}`,
                    '  authorizationUrl:',
                    `  ${started.authorizationUrl}`,
                  ].join('\n'),
                );
                return;
              }
            }
            listener?.close();
            print(
              [
                `Subscription OAuth Start: ${provider}`,
                `  source: ${policy.formatSource(resolved.source)}`,
                `  state: ${started.pending.state}`,
                `  redirectUri: ${activeConfig.redirectUri}`,
                `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
                `  next: /subscription login ${provider} finish <code-or-url>`,
                '  authorizationUrl:',
                `  ${started.authorizationUrl}`,
              ].join('\n'),
            );
            return;
          }
          if (mode === 'finish') {
            const codeInput = args[3];
            if (!codeInput) {
              print(`Usage: /subscription login ${provider} finish <code-or-url>`);
              return;
            }
            const code = extractAuthorizationCode(codeInput) ?? codeInput;
            if (provider === 'openai' && resolved.source === 'builtin') {
              const pending = manager.getPending(provider);
              if (!pending) {
                print(`No pending OAuth login for ${provider}. Start with /subscription login ${provider} start.`);
                return;
              }
              let token;
              try {
                token = await exchangeOpenAICodexCode(code, pending.verifier);
              } catch (error) {
                if (!policy.catchErrors) throw error;
                print(`Could not exchange authorization code for ${provider}: ${policy.error(error)}`);
                return;
              }
              const now = Date.now();
              const record = manager.saveSubscription({
                provider,
                accessToken: token.accessToken,
                refreshToken: token.refreshToken,
                tokenType: token.tokenType,
                expiresAt: token.expiresAt,
                ...(token.scopes ? { scopes: token.scopes } : {}),
                authMode: 'oauth',
                overrideAmbientApiKeys: false,
                createdAt: manager.get(provider)?.createdAt ?? now,
                updatedAt: now,
              });
              print(
                [
                  `Stored subscription session for ${provider}.`,
                  `  tokenType: ${record.tokenType}`,
                  `  expiresAt: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
                  describePrecedence(record),
                ].join('\n'),
              );
              return;
            }
            const activeConfig = resolveLoginConfig(resolved.oauth, false);
            let record;
            try {
              record = await manager.completeOAuthLogin(provider, activeConfig, code);
            } catch (error) {
              if (!policy.catchErrors) throw error;
              print(`Could not complete OAuth login for ${provider}: ${policy.error(error)}`);
              return;
            }
            print(
              [
                `Stored subscription session for ${provider}.`,
                `  tokenType: ${record.tokenType}`,
                `  expiresAt: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
                describePrecedence(record),
              ].join('\n'),
            );
            return;
          }
          print('Usage: /subscription login <provider> start|finish <code-or-url>');
          return;
        }
        if (sub === 'logout') {
          const provider = args[1];
          if (!provider) {
            print('Usage: /subscription logout <provider>');
            return;
          }
          if (!parsed.yes) {
            requireYesFlag(ctx, `log out provider subscription ${provider}`, '/subscription logout <provider> --yes');
            return;
          }
          const removed = manager.logout(provider);
          print(
            removed
              ? `Logged out of ${provider}. Ambient API key resolution will apply again if configured.`
              : `No stored subscription session existed for ${provider}.`,
          );
          return;
        }
        if (sub === 'bundle') {
          const mode = args[1]?.toLowerCase();
          const pathArg = args[2];
          if (!mode || !pathArg) {
            print('Usage: /subscription bundle <export|inspect> <path>');
            return;
          }
          const targetPath = (shellPaths ?? requireShellPaths(ctx)).resolveWorkspacePath(pathArg);
          if (mode === 'export') {
            if (!parsed.yes) {
              requireYesFlag(ctx, `export subscription bundle to ${pathArg}`, '/subscription bundle export <path> --yes');
              return;
            }
            const bundle: SubscriptionBundle = {
              version: 1,
              exportedAt: Date.now(),
              subscriptions: manager.list(),
            };
            mkdirSync(dirname(targetPath), { recursive: true });
            writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
            print(`Subscription bundle exported to ${targetPath}`);
            if (policy.bundleWarning) print('This file contains active sign-in tokens. Keep it private and delete it after use.');
            return;
          }
          if (mode === 'inspect') {
            try {
              print(inspectBundle(targetPath));
            } catch (error) {
              if (!policy.catchErrors) throw error;
              print(`Could not read that bundle file: ${policy.error(error)}`);
            }
            return;
          }
          print('Usage: /subscription bundle <export|inspect> <path>');
          return;
        }
        print(
          'Usage: /subscription [review|list|providers|inspect <provider>|login <provider> start [--no-browser] [--manual]|finish <code-or-url>|logout <provider>|bundle export <path>|bundle inspect <path>]',
        );
      },
    });
  }
  return { registerSubscriptionRuntimeCommands };
}

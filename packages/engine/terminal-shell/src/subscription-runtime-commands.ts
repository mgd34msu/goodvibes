import { readFileSync } from 'node:fs';
import {
  atomicWriteFileSync,
  createOAuthLocalListener,
  getSubscriptionProviderConfig,
  listAvailableSubscriptionProviders,
  type OAuthProviderConfig,
  type ProviderSubscription,
  type SubscriptionManager,
} from '@goodvibes-jev/engine/platform/platform/config';
import { inspectProviderAuth } from '@goodvibes-jev/engine/platform/platform/runtime/security';
import { openExternalUrl, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { TerminalCommandRegistry } from './command-registry.js';
import { readAuthorizationInput } from './settings-subscriptions.js';
import { commandRefusal, requireYesFlag, stripYesFlag, type CommandConfirmationContext } from './command-confirmation.js';
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
    readonly eagerPaths: boolean;
    readonly openModalOnEmpty: boolean;
    readonly manualOnly: boolean;
    /** No longer read: the export warning is always printed. */
    readonly bundleWarning?: boolean | undefined;
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
  function readSubscriptionBundle(value: unknown): SubscriptionBundle | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<Record<keyof SubscriptionBundle, unknown>>;
    if (candidate.version !== 1 || typeof candidate.exportedAt !== 'number' || !Number.isFinite(candidate.exportedAt)) return null;
    if (Number.isNaN(new Date(candidate.exportedAt).getTime())) return null;
    const list = candidate.subscriptions;
    if (!Array.isArray(list)) return null;
    const subscriptions: ProviderSubscription[] = [];
    for (const entry of list) {
      const record = readBundleSubscription(entry);
      if (!record) return null;
      subscriptions.push(record);
    }
    return { version: 1, exportedAt: candidate.exportedAt, subscriptions };
  }
  /** One exported sign-in, keeping only the fields a stored session has; a refresh in flight is not carried over. */
  function readBundleSubscription(entry: unknown): ProviderSubscription | null {
    if (!entry || typeof entry !== 'object') return null;
    const r = entry as Record<string, unknown>;
    const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
    if (typeof r['provider'] !== 'string' || r['provider'].length === 0 || r['authMode'] !== 'oauth') return null;
    if (typeof r['accessToken'] !== 'string' || r['accessToken'].length === 0 || typeof r['tokenType'] !== 'string') return null;
    if (!isTime(r['createdAt']) || !isTime(r['updatedAt']) || typeof r['overrideAmbientApiKeys'] !== 'boolean') return null;
    if (r['refreshToken'] !== undefined && typeof r['refreshToken'] !== 'string') return null;
    if (r['expiresAt'] !== undefined && !isTime(r['expiresAt'])) return null;
    if (r['revokedAt'] !== undefined && !isTime(r['revokedAt'])) return null;
    const scopes = r['scopes'];
    if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string'))) return null;
    return {
      provider: r['provider'],
      accessToken: r['accessToken'],
      ...(r['refreshToken'] !== undefined ? { refreshToken: r['refreshToken'] as string } : {}),
      tokenType: r['tokenType'],
      ...(r['expiresAt'] !== undefined ? { expiresAt: r['expiresAt'] as number } : {}),
      ...(scopes !== undefined ? { scopes: scopes as string[] } : {}),
      authMode: 'oauth',
      overrideAmbientApiKeys: r['overrideAmbientApiKeys'],
      createdAt: r['createdAt'],
      updatedAt: r['updatedAt'],
      ...(r['revokedAt'] !== undefined ? { revokedAt: r['revokedAt'] as number } : {}),
    };
  }
  /** What importing `bundle` would do to each provider: add a sign-in or replace the stored one. */
  function describeImport(manager: SubscriptionManager, bundle: SubscriptionBundle): string[] {
    return bundle.subscriptions.map((subscription) => {
      const current = manager.get(subscription.provider);
      const expires = subscription.expiresAt ? `expires ${new Date(subscription.expiresAt).toISOString()}` : 'no expiry';
      return current
        ? `  ${subscription.provider}  replaces the stored sign-in (updated ${new Date(current.updatedAt).toISOString()}) with one updated ${new Date(subscription.updatedAt).toISOString()}, ${expires}`
        : `  ${subscription.provider}  adds a sign-in, ${expires}`;
    });
  }
  function inspectBundle(path: string): string {
    const bundle = readSubscriptionBundle(JSON.parse(readFileSync(path, 'utf-8')) as unknown);
    if (!bundle) return `${path} is not a subscription bundle (expected version 1 with exportedAt and a list of complete sign-ins).`;
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
      effect: 'mixed',
      aliases: ['subs'],
      description: 'Manage provider subscription sessions and, when supported, let them override ambient API keys for matching providers',
      usage:
        '[review|list|providers|inspect <provider>|login <provider> start [--no-browser] [--manual]|finish <code-or-url>|logout <provider>|bundle export <path> --yes|bundle inspect <path>|bundle import <path> --yes]',
      // The sign-in code (or the redirect address that carries it) is never kept in the input history.
      secretArgs: {
        select: (args) => (args[0]?.toLowerCase() === 'login' && args[2]?.toLowerCase() === 'finish' ? [3] : []),
      },
      ...(policy.hidden ? { hidden: true } : {}),
      async handler(args, ctx) {
        // Export writes live sign-in tokens, so it needs an explicit --yes even where other mutations do not.
        const explicit = stripYesFlag(args);
        const parsed = { rest: explicit.rest, yes: true };
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
          if (!provider) throw commandRefusal('Usage: /subscription inspect <provider>');
          const resolved = getSubscriptionProviderConfig(provider, services.get(provider));
          if (!resolved && !manager.get(provider) && !manager.getPending(provider)) {
            throw commandRefusal(`No stored or available subscription provider named ${provider}.`, '/subscription providers lists the providers that support a subscription', 'NOT_FOUND');
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
            throw commandRefusal(`Could not inspect provider auth for ${provider}: ${policy.error(error)}`, undefined, 'NOT_DONE');
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
          if (!provider || !mode) throw commandRefusal('Usage: /subscription login <provider> start|finish <code>');
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
            throw commandRefusal(
              `OAuth is not configured for ${provider}.`,
              [
                `Add an oauth block to ~/.goodvibes/${policy.surfaceRoot}/services.json (your own services file; a project's file cannot carry one) for that provider, for example:`,
                `  { "name": "${provider}", "authType": "oauth", "tokenKey": "${provider.toUpperCase()}_API_KEY", "providerId": "${provider}", "oauth": { "authUrl": "...", "tokenUrl": "...", "clientId": "...", "redirectUri": "http://127.0.0.1/callback", "scopes": ["..."] } }`,
              ].join('\n'),
              'OAUTH_NOT_CONFIGURED',
            );
          }
          if (mode === 'start') {
            const flags = new Set(args.slice(3));
            const openBrowser = !flags.has('--no-browser');
            const useManualMode = policy.manualOnly || flags.has('--manual');
            const useLocalCallback = Boolean(resolved.oauth.localCallback) && !useManualMode;
            let activeConfig = resolveLoginConfig(resolved.oauth, useLocalCallback);
            let listener: Awaited<ReturnType<typeof createOAuthLocalListener>> | null = null;
            let listenerNote: string | undefined;
            if (useLocalCallback && resolved.oauth.localCallback) {
              listener = await createOAuthLocalListener({
                expectedState: '',
                host: resolved.oauth.localCallback.host,
                port: resolved.oauth.localCallback.port,
                path: resolved.oauth.localCallback.path,
              }).catch((error: unknown) => {
                // Optional: without it the user finishes by pasting the code, but the reason is shown.
                listenerNote = `automatic completion unavailable (${summarizeError(error)})`;
                return null;
              });
            }
            try {
              if (listener) {
                activeConfig = { ...activeConfig, redirectUri: listener.redirectUri };
              }
              const started = await manager.beginOAuthLogin(provider, activeConfig);
              if (listener) {
                listener.setExpectedState(started.pending.state);
              }
              const browserOpened = openBrowser ? await openExternalUrl(started.authorizationUrl) : false;
              const shouldAutoComplete = Boolean(listener) && (resolved.oauth.localCallback?.autoComplete ?? true) && browserOpened;
              // The address is printed before any wait, so a browser that opened
              // elsewhere (another display, an SSH hop) never leaves the person
              // without the one thing they need to finish.
              print(
                [
                  `Subscription OAuth Start: ${provider}`,
                  `  source: ${policy.formatSource(resolved.source)}`,
                  `  state: ${started.pending.state}`,
                  `  redirectUri: ${activeConfig.redirectUri}`,
                  `  browser: ${openBrowser ? (browserOpened ? 'opened' : 'open failed') : 'skipped'}`,
                  ...(listenerNote ? [`  listener: ${listenerNote}`] : []),
                  '  authorizationUrl:',
                  `  ${started.authorizationUrl}`,
                  shouldAutoComplete
                    ? `  waiting for the browser to finish; if it opened somewhere else, open the address above and run /subscription login ${provider} finish <code-or-url>`
                    : `  next: /subscription login ${provider} finish <code-or-url>`,
                ].join('\n'),
              );
              if (shouldAutoComplete && listener) {
                try {
                  const callback = await listener.waitForCode();
                  const record = await manager.completeOAuthLogin(provider, activeConfig, callback.code);
                  print(
                    [
                      `Subscription OAuth Complete: ${provider}`,
                      `  tokenType: ${record.tokenType}`,
                      `  expiresAt: ${record.expiresAt ? new Date(record.expiresAt).toISOString() : 'n/a'}`,
                      describePrecedence(record),
                    ].join('\n'),
                  );
                } catch (error) {
                  // A `finish` typed meanwhile already stored the sign-in: nothing to report.
                  if (!manager.getPending(provider) && manager.get(provider)) return;
                  throw commandRefusal(
                    `Subscription OAuth for ${provider} did not finish automatically (${summarizeError(error)}); the sign-in is still pending.`,
                    `Run /subscription login ${provider} finish <code-or-url> with the redirect address or code`,
                    'OAUTH_PENDING',
                  );
                }
              }
              return;
            } finally {
              listener?.close();
            }
          }
          if (mode === 'finish') {
            const codeInput = args[3];
            if (!codeInput) throw commandRefusal(`Usage: /subscription login ${provider} finish <code-or-url>`);
            const pendingLogin = manager.getPending(provider);
            const authorization = readAuthorizationInput(codeInput, pendingLogin?.state);
            if (!authorization.ok) throw commandRefusal(authorization.reason, undefined, 'OAUTH_CODE_REFUSED');
            const code = authorization.code;
            const activeConfig = resolveLoginConfig(resolved.oauth, false);
            let record;
            try {
              record = await manager.completeOAuthLogin(provider, activeConfig, code);
            } catch (error) {
              if (!policy.catchErrors) throw error;
              throw commandRefusal(`Could not complete OAuth login for ${provider}: ${policy.error(error)}`, undefined, 'NOT_DONE');
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
          throw commandRefusal('Usage: /subscription login <provider> start|finish <code-or-url>');
        }
        if (sub === 'logout') {
          const provider = args[1];
          if (!provider) throw commandRefusal('Usage: /subscription logout <provider>');
          if (!parsed.yes) {
            requireYesFlag(ctx, `log out provider subscription ${provider}`, '/subscription logout <provider> --yes');
            return;
          }
          const removed = await manager.logout(provider);
          print(
            removed
              ? `Logged out of ${provider}. Ambient API key resolution will apply again if configured.`
              : `No stored subscription session existed for ${provider}.`,
          );
          return;
        }
        if (sub === 'bundle') {
          const bundleArgs = explicit.rest;
          const mode = bundleArgs[1]?.toLowerCase();
          const pathArg = bundleArgs[2];
          if (!mode || !pathArg) throw commandRefusal('Usage: /subscription bundle <export|inspect|import> <path>');
          const targetPath = (shellPaths ?? requireShellPaths(ctx)).resolveWorkspacePath(pathArg);
          if (mode === 'export') {
            if (!explicit.yes) {
              requireYesFlag(ctx, `export subscription bundle to ${pathArg}`, '/subscription bundle export <path> --yes');
              return;
            }
            const bundle: SubscriptionBundle = {
              version: 1,
              exportedAt: Date.now(),
              subscriptions: manager.list(),
            };
            // Owner-only (0600): the file holds access and refresh tokens.
            atomicWriteFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, { mkdirp: true });
            print(`Subscription bundle exported to ${targetPath}`);
            print('This file contains active sign-in tokens. Keep it private and delete it after use.');
            return;
          }
          if (mode === 'inspect') {
            let review: string;
            try {
              review = inspectBundle(targetPath);
            } catch (error) {
              if (!policy.catchErrors) throw error;
              throw commandRefusal(`Could not read that bundle file: ${policy.error(error)}`, undefined, 'BUNDLE_UNREADABLE');
            }
            print(review);
            return;
          }
          if (mode === 'import') {
            let bundle: SubscriptionBundle | null;
            try {
              bundle = readSubscriptionBundle(JSON.parse(readFileSync(targetPath, 'utf-8')) as unknown);
            } catch (error) {
              if (!policy.catchErrors) throw error;
              throw commandRefusal(`Could not read that bundle file: ${policy.error(error)}. Nothing was changed.`, undefined, 'BUNDLE_UNREADABLE');
            }
            if (!bundle) {
              throw commandRefusal(`Not imported: ${targetPath} is not a subscription bundle (expected version 1 with exportedAt and a list of complete sign-ins). Nothing was changed.`, undefined, 'BUNDLE_UNREADABLE');
            }
            if (bundle.subscriptions.length === 0) {
              throw commandRefusal(`Not imported: ${targetPath} holds no sign-ins. Nothing was changed.`, undefined, 'BUNDLE_EMPTY');
            }
            if (!explicit.yes) {
              print(['Subscription bundle import would:', ...describeImport(manager, bundle)].join('\n'));
              requireYesFlag(ctx, `import ${bundle.subscriptions.length} subscription sign-in(s) from ${pathArg}`, '/subscription bundle import <path> --yes');
              return;
            }
            const lines = describeImport(manager, bundle);
            for (const subscription of bundle.subscriptions) await manager.saveSubscription(subscription);
            print([`Imported ${bundle.subscriptions.length} subscription sign-in(s) from ${targetPath}:`, ...lines].join('\n'));
            return;
          }
          throw commandRefusal('Usage: /subscription bundle <export|inspect|import> <path>');
        }
        throw commandRefusal(
          'Usage: /subscription [review|list|providers|inspect <provider>|login <provider> start [--no-browser] [--manual]|finish <code-or-url>|logout <provider>|bundle export <path> --yes|bundle inspect <path>|bundle import <path> --yes]',
        );
      },
    });
  }
  return { registerSubscriptionRuntimeCommands };
}

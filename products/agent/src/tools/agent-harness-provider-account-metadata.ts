import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { captureCatalogSnapshot, rankHarnessCatalog, type CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { captureCatalogReadRequest, selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import { withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { captureServiceReadSource, captureSubscriptionReadSource, listBuiltinSubscriptionProviders } from '@goodvibes-jev/engine/platform/platform/config';
import type { CommandContext } from '../input/command-registry.ts';
import { buildProviderAccountSnapshot, type ProviderAccountRecord, type ProviderAccountSnapshot } from '@/runtime/index.ts';
import { clampReadLimit } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

type ProviderCatalogContext = {
  readonly provider: Pick<CommandContext['provider'], 'providerRegistry'>;
  /** Only key presence is read from the credential store, so only `get` is required of it. */
  readonly platform: Pick<CommandContext['platform'], 'configManager' | 'serviceRegistry' | 'subscriptionManager'>
    & { readonly secretsManager?: { get(key: string): Promise<string | null> } | undefined };
};
import { previewHarnessText } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

export interface AgentHarnessProviderAccountArgs {
  readonly providerId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type ProviderAccountLookupSource = 'providerId' | 'target' | 'query';

type ProviderAccountResolution =
  | { readonly status: 'found'; readonly account: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 500);
}

const noStoredKeys = { get: async (_key: string): Promise<string | null> => null };

async function loadSnapshot(context: ProviderCatalogContext, request?: ReturnType<typeof captureCatalogReadRequest<AgentHarnessProviderAccountArgs>>): Promise<ProviderAccountSnapshot> {
  if (!request) {
    const services = context.platform.serviceRegistry, subscriptions = context.platform.subscriptionManager;
    if (!services || !subscriptions) throw new ToolInputProjectionError('unavailable');
    return buildProviderAccountSnapshot({ providerRegistry: context.provider.providerRegistry, serviceRegistry: services,
      subscriptionManager: subscriptions, secretsManager: context.platform.secretsManager ?? noStoredKeys });
  }
  const platform = context.platform, provider = context.provider;
  const models = provider.providerRegistry, services = platform.serviceRegistry, subscriptions = platform.subscriptionManager;
  if (!services || !subscriptions) throw new ToolInputProjectionError('unavailable');
  const manager = platform.configManager;
  const modelOwner = models.captureProviderCatalogIds();
  const serviceCurrent = captureServiceReadSource(services), subscriptionCurrent = captureSubscriptionReadSource(subscriptions);
  const listModels = models.listModels, getAll = services.getAll, inspect = services.inspect;
  const list = subscriptions.list, listPending = subscriptions.listPending, get = subscriptions.get, getPending = subscriptions.getPending;
  const configuration = manager.getAutonomousPermissionSnapshot, incarnation = configuration.call(manager).incarnation;
  const environment = process.env;
  const expirationPhase = (expiresAt: number | undefined) => {
    if (expiresAt === undefined) return 'unspecified';
    const observed = Date.now();
    return expiresAt <= observed ? 'expired' : expiresAt <= observed + 24 * 60 * 60 * 1000 ? 'expiring' : 'healthy';
  };
  const expirations: { readonly expiresAt: number | undefined; readonly phase: ReturnType<typeof expirationPhase> }[] = [];
  const environmentPresence = new Map<string, boolean>();
  const keyNames = new Set<string>();
  const inspectionGuards: (() => void)[] = [];
  const assertOwner = () => {
    modelOwner.assertCurrent();
    if (context.platform !== platform || context.provider !== provider || provider.providerRegistry !== models
      || platform.serviceRegistry !== services || platform.subscriptionManager !== subscriptions || platform.configManager !== manager
      || configuration.call(manager).incarnation !== incarnation || process.env !== environment) throw new ToolInputProjectionError('held');
    serviceCurrent(); subscriptionCurrent();
    for (const entry of expirations) if (expirationPhase(entry.expiresAt) !== entry.phase) throw new ToolInputProjectionError('held');
    for (const [name, present] of environmentPresence) if (Boolean(environment[name]) !== present) throw new ToolInputProjectionError('held');
    for (const guard of inspectionGuards) guard();
  };
  assertOwner();
  const modelSnapshot = captureCatalogSnapshot(listModels.call(models));
  const serviceSnapshot = captureCatalogSnapshot(getAll.call(services));
  const subscriptionSnapshot = captureCatalogSnapshot(list.call(subscriptions));
  const pendingSnapshot = captureCatalogSnapshot(listPending.call(subscriptions));
  for (const subscription of subscriptionSnapshot.captured) {
    expirations.push({ expiresAt: subscription.expiresAt, phase: expirationPhase(subscription.expiresAt) });
  }
  // These are the exact native key candidates consumed by the account
  // snapshot builder. Only presence booleans are retained; values stay local.
  const providerIds = new Set([
    ...modelSnapshot.captured.map(model => model.provider),
    ...Object.values(serviceSnapshot.captured).map(service => service.providerId ?? service.name),
    ...subscriptionSnapshot.captured.map(subscription => subscription.provider),
    ...pendingSnapshot.captured.map(pending => pending.provider),
    ...listBuiltinSubscriptionProviders().map(provider => provider.provider),
  ]);
  for (const providerId of providerIds) {
    const service = Object.values(serviceSnapshot.captured).find(entry => (entry.providerId ?? entry.name) === providerId);
    const keys = new Set<string>(service?.tokenKey ? [service.tokenKey] : []);
    for (const model of modelSnapshot.captured.filter(entry => entry.provider === providerId)) {
      const raw: unknown = (model as { readonly providerEnvVars?: unknown }).providerEnvVars;
      if (Array.isArray(raw)) for (const key of raw) if (typeof key === 'string' && key.trim().length > 0) keys.add(key);
    }
    const normalized = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (normalized) { keys.add(`${normalized}_API_KEY`); keys.add(`${normalized}_KEY`); }
    for (const key of keys) {
      environmentPresence.set(key, Boolean(environment[key]));
      keyNames.add(key);
    }
  }
  // Stored keys are read here, once, and only whether each exists is kept; the
  // snapshot builder then asks about presence and never sees a value. An
  // unreadable store reads as absent, as in the builder.
  const storedPresence = new Map<string, boolean>();
  const secretStore = platform.secretsManager;
  if (secretStore) {
    for (const key of keyNames) {
      if (environmentPresence.get(key)) continue;
      try { storedPresence.set(key, (await secretStore.get(key)) !== null); } catch { storedPresence.set(key, false); }
    }
  }
  const assertSources = () => {
    assertOwner(); modelSnapshot.assertCurrent(listModels.call(models)); serviceSnapshot.assertCurrent(getAll.call(services));
    subscriptionSnapshot.assertCurrent(list.call(subscriptions)); pendingSnapshot.assertCurrent(listPending.call(subscriptions)); assertOwner();
  };
  // Install complete native records before retain can invoke a restriction.
  assertSources();
  request.retain(assertSources, 'read-catalog.provider.records');
  const current = () => { request.assertCurrent(); assertSources(); };
  const snapshot = await buildProviderAccountSnapshot({
    providerRegistry: {
      listModels() { current(); const value = listModels.call(models); current(); return value; },
      getCurrentModel() { current(); return models.getCurrentModel(); },
      getRegistered(name) { current(); return models.getRegistered(name); },
      describeRuntime(providerId) { current(); return models.describeRuntime(providerId); },
    },
    serviceRegistry: {
      getAll() { current(); const value = getAll.call(services); current(); return value; },
      async inspect(name) { current(); const value = await inspect.call(services, name);
        const saved = captureCatalogSnapshot(value); inspectionGuards.push(() => saved.assertCurrent(value)); current(); return value; },
      unreadableReason() { current(); return services.unreadableReason(); },
    },
    subscriptionManager: {
      list() { current(); const value = list.call(subscriptions); current(); return value; },
      listPending() { current(); const value = listPending.call(subscriptions); current(); return value; },
      get(id) { current(); const value = get.call(subscriptions, id); current(); return value; },
      getPending(id) { current(); const value = getPending.call(subscriptions, id); current(); return value; },
    },
    // Only presence leaves this reader: a stored key reads as an empty string, never its value.
    secretsManager: { async get(key) {
      current();
      const known = storedPresence.get(key);
      if (known !== undefined) return known ? '' : null;
      if (!secretStore) return null;
      try { return (await secretStore.get(key)) !== null ? '' : null; } catch { return null; }
    } },
  });
  const saved = captureCatalogSnapshot(snapshot);
  current();
  request.retain(() => saved.assertCurrent(snapshot), 'read-catalog.provider.snapshot');
  return saved.captured;
}

function accountReadingEvidence(account: ProviderAccountRecord): Record<string, unknown> {
  return account.expiresAt === undefined ? { ...account } : { ...account, expiresAt: new Date(account.expiresAt).toISOString() };
}

function lookupFromArgs(args: AgentHarnessProviderAccountArgs): { readonly source: ProviderAccountLookupSource; readonly input: string } | null {
  const providerId = readString(args.providerId);
  if (providerId) return { source: 'providerId', input: providerId };
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

function providerAccountModelRoute(): string {
  return 'agent_harness mode:"provider_account" or mode:"run_command"';
}

function describeAccount(
  account: ProviderAccountRecord,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    providerId: account.providerId,
    active: account.active,
    configured: account.configured,
    modelCount: account.modelCount,
    oauthReady: account.oauthReady,
    pendingLogin: account.pendingLogin,
    availableRoutes: account.availableRoutes,
    preferredRoute: account.preferredRoute,
    activeRoute: account.activeRoute,
    activeRouteReason: account.activeRouteReason,
    authFreshness: account.authFreshness,
    ...(account.fallbackRoute ? { fallbackRoute: account.fallbackRoute } : {}),
    ...(account.fallbackRisk ? { fallbackRisk: account.fallbackRisk } : {}),
    ...(account.expiresAt ? { expiresAt: new Date(account.expiresAt).toISOString() } : {}),
    ...(account.tokenType ? { tokenType: account.tokenType } : {}),
    issueCount: account.issues.length,
    recommendedActionCount: account.recommendedActions.length,
    modelRoute: providerAccountModelRoute(),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters
      ? {
        routeRecords: account.routeRecords.map((route) => ({
          route: route.route,
          usable: route.usable,
          freshness: route.freshness,
          detail: route.detail,
          issues: route.issues,
        })),
        usageWindows: account.usageWindows,
        issues: account.issues,
        notes: account.notes,
        recommendedActions: account.recommendedActions,
        policy: {
          effect: 'read-only',
          values: 'Provider account posture reports route and freshness metadata only; raw tokens, authorization codes, and secret values are never returned.',
          mutation: 'Provider login, logout, subscription bundle export, and account repair actions stay explicit confirmation-gated workspace or slash-command flows.',
        },
        modelAccess: {
          reviewCommand: '/accounts review',
          showCommand: `/accounts show ${account.providerId}`,
          routesCommand: `/accounts routes ${account.providerId}`,
          repairCommand: `/accounts repair ${account.providerId}`,
          subscriptionInspectCommand: `/subscription inspect ${account.providerId}`,
          workspaceActions: [
            'provider-accounts',
            'provider-account-repair',
            'subscription-review',
            'subscription-inspect',
          ],
          loginStartCommand: `/subscription login ${account.providerId} start --yes`,
          loginFinishCommand: `/subscription login ${account.providerId} finish <code-or-url> --yes`,
          logoutCommand: `/subscription logout ${account.providerId} --yes`,
          confirmationRequired: true,
        },
      }
      : {
        summary: previewHarnessText(`${account.providerId} ${account.authFreshness}; ${account.issues.length} issue(s)`),
      }),
  };
}

export async function providerAccountCatalogStatus(context: ProviderCatalogContext): Promise<Record<string, unknown>> {
  const snapshot = await loadSnapshot(context);
  return {
    modes: ['provider_accounts', 'provider_account'],
    providers: snapshot.providers.length,
    configured: snapshot.configuredCount,
    issues: snapshot.issueCount,
    readOnly: true,
  };
}

export async function providerAccountSummary(context: ProviderCatalogContext, args: AgentHarnessProviderAccountArgs,
  options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  const request = captureCatalogReadRequest(args, options), snapshot = await loadSnapshot(context, request);
  request.assertCurrent();
  const source = { invocation: request.input, capturedAt: new Date(snapshot.capturedAt).toISOString(),
    providers: snapshot.providers.map(accountReadingEvidence), configured: snapshot.configuredCount, issues: snapshot.issueCount };
  return withModelReadingSource(source, request.options, async (_captured, current) => {
    const query = readString(request.input.query), includeParameters = request.input.includeParameters === true;
    const selected = query ? await rankHarnessCatalog(snapshot.providers, query,
      account => ({ id: account.providerId, description: `Provider account ${account.providerId}`, evidence: accountReadingEvidence(account) }),
      'agent.provider-account.search', { ...current, requirePreservedSource: true })
      : { matches: snapshot.providers.map(entry => ({ entry })), judgments: [] };
    current.assertCurrent?.();
    const accounts = selected.matches.map(({ entry }) => entry).slice(0, readLimit(request.input.limit, 100));
    return { capturedAt: source.capturedAt, providers: accounts.map(account => describeAccount(account, { includeParameters })),
      returned: accounts.length, total: snapshot.providers.length, configured: snapshot.configuredCount, issues: snapshot.issueCount,
      ...(query ? { judgments: selected.judgments } : {}),
      policy: 'Read-only provider account posture. Use confirmed workspace actions or slash-command mirrors for login/logout/bundle mutations.' };
  });
}

export async function describeHarnessProviderAccount(context: ProviderCatalogContext, args: AgentHarnessProviderAccountArgs,
  options: CatalogRankingOptions = {}): Promise<ProviderAccountResolution> {
  const request = captureCatalogReadRequest(args, options), lookup = lookupFromArgs(request.input);
  if (!lookup) { request.assertCurrent(); return { status: 'missing_lookup', usage: 'provider_account requires providerId, target, or query. Prefer models action:"providers" to inspect provider ids.' }; }
  const snapshot = await loadSnapshot(context, request);
  request.assertCurrent();
  return withModelReadingSource({ invocation: request.input, capturedAt: new Date(snapshot.capturedAt).toISOString(),
    providers: snapshot.providers.map(accountReadingEvidence) }, request.options, async (_captured, current): Promise<ProviderAccountResolution> => {
    const exact = snapshot.providers.find(account => account.providerId === lookup.input);
    const insensitive = exact ?? snapshot.providers.find(account => account.providerId.toLowerCase() === lookup.input.toLowerCase());
    const selected = insensitive ?? await selectHarnessCatalog(snapshot.providers.map((account, index) => ({ index, evidence: accountReadingEvidence(account) })),
      lookup.input, row => ({ id: String(row.index), description: `Provider account ${snapshot.providers[row.index]?.providerId ?? ''}`, evidence: row.evidence }),
      current, 'agent.provider-account.select').then(row => row ? snapshot.providers[row.index] ?? null : null);
    current.assertCurrent?.();
    if (!selected) return { status: 'missing_lookup', usage: `No provider account was selected for ${lookup.input}. Prefer models action:"providers" to inspect provider ids.` };
    return { status: 'found', account: describeAccount(selected, { includeParameters: true,
      lookup: { ...lookup, resolvedBy: exact ? 'id' : insensitive ? 'case-insensitive-id' : 'selection' } }) };
  });
}

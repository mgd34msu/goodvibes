/**
 * Models and providers, kept by the daemon in one copy for every program on
 * this machine: the shared default model, its backups and how requests are
 * routed (settings the daemon's settings file holds, config-ownership.ts),
 * pinned models (the daemon's favourites), providers of your own (the
 * daemon's providers folder), subscription sign-ins (the shared sign-ins
 * file, tokens in the daemon's secret store), and what each provider account
 * looks like. Each program's turns read the same files and settings; a
 * conversation's own model and effort stay with the program holding it.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, writeSync, existsSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { callerPathOf, readCallerJson } from '../path-inputs.js';
import type { ConfigManager } from '../../config/manager.js';
import type { SecretsManager } from '../../config/secrets.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { ProviderSubscription, SubscriptionGrant, SubscriptionManager } from '../../config/subscriptions.js';
import { subscriptionExportForm } from '../../config/subscriptions.js';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { getSubscriptionProviderConfig, listAvailableSubscriptionProviders, listBuiltinSubscriptionProviders } from '../../config/subscription-providers.js';
import type { ProviderApi } from '../../providers/provider-api.js';
import type { ProviderOptimizer } from '../../providers/optimizer.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { LLMProvider } from '../../providers/interface.js';
import { buildProviderAccountSnapshot, type ProviderAccountRecord, type ProviderAccountSnapshot } from '../../runtime/provider-accounts/registry.js';
import { buildAuthInspectionSnapshot, inspectProviderAuth, type ProviderAuthInspection } from '../../runtime/auth/inspection.js';
import { summarizeError } from '../../utils/error-display.js';
import { CapabilityRefusal, REPLACED_DONE, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';
import { addCustomProvider, customProviderNames, removeCustomProvider } from './custom-providers.js';
import type { MethodCapabilityDefinition } from './method-capability.js';

/** The secret a provider of your own keeps its key under (the model picker names it when a key is missing). */
export { customProviderKeyName } from './custom-providers.js';

/** What the model and provider capabilities need: the daemon's own provider stack and stores. */
export interface ModelsCapabilityServices {
  readonly models: {
    readonly providerRegistry: ProviderRegistry;
    readonly providerApi: ProviderApi;
    readonly providerOptimizer: ProviderOptimizer;
    readonly subscriptionManager: SubscriptionManager;
    readonly serviceRegistry: ServiceRegistry;
    readonly secretsManager: SecretsManager;
    readonly configManager: Pick<ConfigManager, 'get' | 'set' | 'setDynamic' | 'getCustomProvidersDir' | 'getWorkingDirectory'>;
    /** The media providers the daemon makes images and video with. */
    readonly mediaProviders: { status(): Promise<readonly MediaProviderStatusLike[]> };
    /** Look for model servers on this computer, add them to the providers and keep them for the next start. */
    readonly scanThisComputer: () => Promise<{
      readonly found: readonly { readonly name: string; readonly host: string; readonly port: number; readonly models: readonly string[] }[];
      readonly skipped: readonly { readonly host: string; readonly port: number; readonly reason: string }[];
      readonly durationMs: number;
    }>;
    /** Tell every client the providers changed (PROVIDERS_CHANGED): a pin, a route or a sign-in was changed here. */
    readonly announce: (change: { readonly added?: readonly string[]; readonly removed?: readonly string[]; readonly updated?: readonly string[] }) => void;
  };
}

/** One media provider's state, as the media registry reports it. */
export interface MediaProviderStatusLike {
  readonly id: string;
  readonly label?: string | undefined;
  readonly state: string;
  readonly configured: boolean;
  readonly capabilities: readonly string[];
  readonly detail?: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}

type Models = ModelsCapabilityServices['models'];

// ---------------------------------------------------------------------------
// Lists an input chooses from (registered by name in terminal-shell's models lists)
// ---------------------------------------------------------------------------

/** The models you can switch to. */
export const MODELS_LIST = 'models' as ListName;
/** Your backup models, in the order they are tried. */
export const BACKUP_MODELS_LIST = 'models.backups' as ListName;
/** Every model the daemon knows (a pin may name any of them). */
export const ALL_MODELS_LIST = 'models.all' as ListName;
/** The pinned models. */
export const PINNED_MODELS_LIST = 'models.pinned' as ListName;
/** The providers you have. */
export const PROVIDERS_LIST = 'providers' as ListName;
/** One provider's models, for the provider chosen before. */
export const PROVIDER_MODELS_LIST = 'providers.models' as ListName;
/** Your own providers. */
export const CUSTOM_PROVIDERS_LIST = 'providers.custom' as ListName;
/** The providers that offer a subscription sign-in. */
export const SUBSCRIPTIONS_AVAILABLE_LIST = 'subscriptions.available' as ListName;
/** Sign-ins waiting for their code. */
export const SUBSCRIPTIONS_PENDING_LIST = 'subscriptions.pending' as ListName;
/** Your subscription sign-ins. */
export const SUBSCRIPTIONS_STORED_LIST = 'subscriptions.stored' as ListName;
/** The provider accounts. */
export const ACCOUNT_PROVIDERS_LIST = 'accounts.providers' as ListName;
/** The providers a sign-in can be read for. */
export const AUTH_PROVIDERS_LIST = 'auth.providers' as ListName;

const PLACE = 'Models and providers';

function iso(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'no expiry';
}

/**
 * A file path the caller gave, placed by capabilities/path-inputs.ts `callerPathOf`: inside its checked project for
 * anyone but the person; a relative path from a caller that named no project is refused, the daemon's own folder never
 * taken in its place.
 */
function filePath(_models: Models, caller: CapabilityCaller, path: string): string {
  return callerPathOf(caller, path);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function backupOrder(models: Models): string[] {
  return stringList(models.configManager.get('provider.fallbackModels'));
}

/** A provider counts as set up when it has a credential or needs none. */
function isSetUp(provider: LLMProvider): boolean {
  const state = provider.describeAuthState?.();
  if (state) return state.configured || state.anonymousReady === true;
  return provider.isConfigured?.() ?? true;
}

function modelInput(help: string, list: ListName = MODELS_LIST): InputDescription {
  return { id: 'model', label: 'Model', help, kind: 'choice', choices: { list }, required: true, typed: { position: 1 } };
}

function pathInput(help: string): InputDescription {
  return { id: 'path', label: 'File', help, kind: 'path', freeTextReason: 'a file path on this machine', required: true, typed: { position: 1 } };
}

const REPLACE_INPUT: InputDescription = {
  id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', kind: 'choice',
  choices: [
    { value: 'no', label: 'Keep it and stop', help: 'Nothing is written when the file is there.' },
    { value: 'yes', label: 'Write over it', help: 'What the file holds now is lost.', risk: 'cannot-be-undone', riskDone: REPLACED_DONE },
  ],
  required: { default: 'no', defaultMeans: 'keep it and stop' }, typed: { flag: '--replace', switchOn: 'yes' },
};

// ---------------------------------------------------------------------------
// The shared default model's backups
// ---------------------------------------------------------------------------

export const MODEL_BACKUP: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'model.backup', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'add-backup', label: 'Add a backup model', word: 'backup',
  inputs: [modelInput('The model a turn moves to when yours fails')],
  sentence: 'When a turn fails on your model, it moves to {model} (after any backups already listed), in every program, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove-backup', example: { model: 'openai:gpt-5-mini' },
  async run(values, services) {
    const models = services.models;
    const wanted = values.model!.trim();
    const match = (await models.providerApi.listModels({ selectableOnly: true })).find((model) => model.registryKey === wanted || model.modelId === wanted);
    if (!match) throw new CapabilityRefusal(`No model you can use is named ${wanted}; the backups were not changed.`, 'The Models list in Models and providers shows them.', 'NOT_FOUND');
    const order = backupOrder(models);
    if (order.includes(match.registryKey)) return { text: `${match.registryKey} is already a backup. Backup models, in order: ${order.join(', ')}.`, data: { backups: order } };
    const next = [...order, match.registryKey];
    models.configManager.set('provider.fallbackModels', next);
    models.announce({ updated: [match.providerId] });
    return { text: `Backup models, in order: ${next.join(', ')}.`, data: { backups: next } };
  },
};

export const MODEL_DROP_BACKUP: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'model.drop-backup', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'remove-backup', label: 'Stop falling back to a backup model', word: 'drop-backup',
  inputs: [{ ...modelInput('Your backup models', BACKUP_MODELS_LIST), label: 'Backup model' }],
  sentence: 'A turn that fails will no longer fall back to {model}, in any program, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'add-backup', example: { model: 'openai:gpt-5-mini' },
  async run(values, services) {
    const models = services.models;
    const order = backupOrder(models);
    if (!order.includes(values.model!)) throw new CapabilityRefusal(`${values.model} is not a backup model; nothing was changed.`, 'The Models list in Models and providers marks the backups.', 'NOT_FOUND');
    const next = order.filter((key) => key !== values.model);
    models.configManager.set('provider.fallbackModels', next);
    models.announce({ updated: [] });
    return { text: next.length === 0 ? 'No backup model is left: a turn that fails stops and says why.' : `Backup models, in order: ${next.join(', ')}.`, data: { backups: next } };
  },
};

// ---------------------------------------------------------------------------
// Pinned models
// ---------------------------------------------------------------------------

export const PIN_LIST: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'pin.list', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'see-pinned', label: 'See pinned models', word: 'list', inputs: [],
  sentence: 'Lists the models pinned to the top of the model picker, in every program.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const favorites = await services.models.providerApi.getFavorites();
    const pinned = favorites.pinned.map((entry) => ({ registryKey: entry.registryKey, available: entry.available, ...(entry.displayName ? { label: entry.displayName } : {}) }));
    return {
      text: pinned.length === 0 ? 'No pinned models yet.' : ['Pinned models:', ...pinned.map((entry) => `  ${entry.registryKey}${entry.available ? '' : ' (not available now)'}`)].join('\n'),
      data: { pinned },
    };
  },
};

export const PIN_ADD: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'pin.add', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'pin-model', label: 'Pin a model', word: 'add',
  inputs: [{ ...modelInput('The models you can use', ALL_MODELS_LIST), choices: { list: ALL_MODELS_LIST, allowOther: { reason: 'a model id' } } }],
  sentence: '{model} is kept at the top of the model picker, in every program, until you change it.', done: 'Pinned {model}.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'unpin-model', example: { model: 'openrouter:openrouter/free' },
  async run(values, services) {
    const api = services.models.providerApi;
    const key = values.model!.trim();
    const favorites = await api.getFavorites();
    if (favorites.pinned.some((entry) => entry.modelId === key || entry.registryKey === key)) return { text: `${key} is pinned already.`, data: { pinned: favorites.pinned.map((entry) => entry.registryKey) } };
    const after = await api.pinModel(key);
    services.models.announce({ updated: [key.split(':')[0] ?? key] });
    return { text: '', data: { pinned: after.pinned.map((entry) => entry.registryKey) } };
  },
};

export const PIN_REMOVE: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'pin.remove', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'unpin-model', label: 'Unpin a model', word: 'remove',
  inputs: [modelInput('The pinned models', PINNED_MODELS_LIST)],
  sentence: '{model} is no longer kept at the top of the model picker, in any program, until you change it.', done: 'Unpinned {model}.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'pin-model', example: { model: 'openrouter:openrouter/free' },
  async run(values, services) {
    const api = services.models.providerApi;
    const key = values.model!.trim();
    const pinned = (await api.getFavorites()).pinned.find((entry) => entry.registryKey === key || entry.modelId === key);
    if (!pinned) throw new CapabilityRefusal(`${key} is not pinned; nothing was changed.`, 'The Models list in Models and providers marks the pinned models.', 'NOT_FOUND');
    const after = await api.unpinModel(pinned.registryKey);
    services.models.announce({ updated: [pinned.registryKey.split(':')[0] ?? pinned.registryKey] });
    return { text: '', data: { pinned: after.pinned.map((entry) => entry.registryKey) } };
  },
};

// ---------------------------------------------------------------------------
// Routing between providers
// ---------------------------------------------------------------------------

export const ROUTES: readonly FixedChoice[] = [
  { value: 'off', label: 'Only the model you chose', help: 'No failover: a request that fails stops and says why.' },
  { value: 'manual', label: 'Your model, moving on when a provider fails', help: 'A request that fails moves to the next provider that can serve it, and says so.' },
  { value: 'auto', label: 'The best provider for each request', help: 'Each request goes to the most capable provider for what it needs.' },
];

/** How requests are routed now, in words. */
export function routeWords(optimizer: Pick<ProviderOptimizer, 'enabled' | 'pinnedTarget' | 'mode'> | undefined): string {
  if (!optimizer) return 'not known here';
  if (!optimizer.enabled) return 'only the model you chose, no failover';
  if (optimizer.pinnedTarget) return `every request to ${optimizer.pinnedTarget.providerId}/${optimizer.pinnedTarget.modelId}`;
  return optimizer.mode === 'auto' ? 'the best provider for each request' : 'your model, moving on when a provider fails';
}

/** The routing in force as one of the route words (`off`, `manual`, `auto`, `pinned`). */
function routeInForce(optimizer: Pick<ProviderOptimizer, 'enabled' | 'pinnedTarget' | 'mode'>): string {
  if (!optimizer.enabled) return 'off';
  if (optimizer.pinnedTarget) return 'pinned';
  return optimizer.mode === 'auto' ? 'auto' : 'manual';
}

type RouteExplanation = ReturnType<ProviderOptimizer['explainCurrentRoute']>;

function explanationLines(explanation: RouteExplanation): string[] {
  const lines = [`  ${explanation.accepted ? 'can serve' : 'cannot serve'}: ${explanation.providerId}/${explanation.modelId}`, `    ${explanation.summary}`];
  if (!explanation.accepted) {
    for (const rejection of explanation.rejections) lines.push(`    - ${rejection.reason} (has ${rejection.actual}, needs ${rejection.required})`);
    return lines;
  }
  const c = explanation.capability;
  const yes = (value: boolean) => (value ? 'yes' : 'no');
  lines.push(`    streaming ${yes(c.streaming)}, tools ${yes(c.toolCalling)}, parallel tools ${yes(c.parallelTools)}, JSON ${yes(c.jsonMode)}, reasoning ${yes(c.reasoningControls)}`);
  lines.push(`    context ${c.maxContextTokens.toLocaleString()} tokens, output ${c.maxOutputTokens.toLocaleString()} tokens, caching ${c.caching}`);
  return lines;
}

function fallbackLogLines(optimizer: ProviderOptimizer): string[] {
  const log = optimizer.fallbackLog;
  if (log.length === 0) return ['No request has moved to another provider since the daemon started.'];
  const recent = log.slice(-5);
  return [`Recent moves (${recent.length} of ${log.length}):`, ...recent.map((move) => `  ${new Date(move.ts).toISOString().replace('T', ' ').slice(0, 19)}  ${move.from} to ${move.to} (${move.reason})`)];
}

export const PROVIDER_ROUTE: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.route', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'route', label: 'Choose how requests are routed', word: 'route',
  inputs: [{ id: 'mode', label: 'Routing', help: 'Where a request goes, and what happens when a provider fails', kind: 'choice', choices: ROUTES, required: true, typed: { position: 1 } }],
  sentence: 'Requests are routed the way you chose ({mode}) from the next one, in every program, until you change it; a model every request was sent to is let go.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { mode: 'auto' },
  async run(values, services) {
    const models = services.models;
    const mode = values.mode!;
    if (!ROUTES.some((route) => route.value === mode)) throw new CapabilityRefusal(`"${mode}" is not a way to route requests; nothing was changed.`, `The ways: ${ROUTES.map((route) => route.value).join(', ')}.`);
    // provider.optimizerMode owns the routing; the provider stack applies the write to the live optimizer.
    models.configManager.setDynamic('provider.optimizerMode', mode);
    models.announce({ updated: [] });
    return { text: `Requests are routed: ${routeWords(models.providerOptimizer)}.`, data: { routing: routeInForce(models.providerOptimizer) } };
  },
};

export const PROVIDER_PIN_ROUTE: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.pin-route', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'pin-route', label: 'Send every request to one model', word: 'pin-route',
  inputs: [modelInput('The models you can use')],
  sentence: 'Every request goes to {model} and no other provider is tried, in every program, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'route', example: { model: 'openai:gpt-5' },
  async run(values, services) {
    const models = services.models;
    const match = (await models.providerApi.listModels()).find((model) => model.registryKey === values.model);
    if (!match) throw new CapabilityRefusal(`No model ${values.model} is known; the routing was not changed.`, 'The Models list in Models and providers shows the models you can use.', 'NOT_FOUND');
    // The settings own the target; the provider stack applies them to the live optimizer.
    const previousPinned = models.configManager.get('provider.optimizerPinnedModel');
    models.configManager.setDynamic('provider.optimizerPinnedModel', `${match.providerId}:${match.modelId}`);
    try {
      models.configManager.setDynamic('provider.optimizerMode', 'pinned');
    } catch (error) {
      try { models.configManager.setDynamic('provider.optimizerPinnedModel', previousPinned); } catch { /* best-effort rollback */ }
      throw error;
    }
    models.announce({ updated: [match.providerId] });
    return { text: `Every request goes to ${match.providerId}/${match.modelId}. Choosing how requests are routed lets it go.`, data: { routing: 'pinned', model: match.registryKey } };
  },
};

export const PROVIDER_EXPLAIN: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.explain', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'explain', label: 'See why requests go where they go', word: 'explain', inputs: [],
  sentence: 'Shows whether the default model can serve a request and why, how requests are routed, and the last moves to another provider.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const models = services.models;
    let current;
    try {
      current = await models.providerApi.getCurrentModel();
    } catch {
      return { text: 'No model is the default yet: choose one in Models and providers.', data: { routing: routeInForce(models.providerOptimizer) } };
    }
    const explanation = models.providerOptimizer.explainCurrentRoute();
    return {
      text: [`The default model: ${current.providerId}/${current.modelId}`, ...explanationLines(explanation), `Requests are routed: ${routeWords(models.providerOptimizer)}.`, ...fallbackLogLines(models.providerOptimizer)].join('\n'),
      data: { model: current.registryKey, accepted: explanation.accepted, routing: routeInForce(models.providerOptimizer) },
    };
  },
};

export const PROVIDER_FALLBACK: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.fallback', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'test-fallback', label: 'See where a failed request would go', word: 'fallback', inputs: [],
  sentence: 'Shows, without sending anything, which providers a failed request could move to and which could not serve it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const optimizer = services.models.providerOptimizer;
    const result = optimizer.testFallback();
    const capable = result.chain.filter((node) => node.capable);
    const rejected = result.chain.filter((node) => !node.capable);
    return {
      text: [
        `${result.viableCount} of ${result.totalCount} providers could take a failed request (a request that needs nothing special):`,
        ...(capable.length === 0 ? ['  none'] : capable.slice(0, 10).map((node) => `  ${node.position}. ${node.providerId}/${node.modelId}`)),
        ...(capable.length > 10 ? [`  and ${capable.length - 10} more`] : []),
        ...(rejected.length > 0 ? [`Could not serve it (${rejected.length}):`, ...rejected.slice(0, 5).map((node) => `  ${node.providerId}/${node.modelId}: ${node.explanation.accepted ? 'unknown' : node.explanation.rejections.map((rejection) => rejection.reason).join('; ') || 'unknown'}`)] : []),
        ...(rejected.length > 5 ? [`  and ${rejected.length - 5} more`] : []),
        ...fallbackLogLines(optimizer),
      ].join('\n'),
      data: { viable: result.viableCount, total: result.totalCount, chain: capable.slice(0, 10).map((node) => `${node.providerId}:${node.modelId}`) },
    };
  },
};

// ---------------------------------------------------------------------------
// Switching provider (the shared default) and seeing your providers
// ---------------------------------------------------------------------------

export const PROVIDER_USE: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.use', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'use', label: 'Switch provider', word: 'use',
  inputs: [
    { id: 'provider', label: 'Provider', help: 'The providers you have', kind: 'choice', choices: { list: PROVIDERS_LIST }, required: true, typed: { position: 1 } },
    { id: 'model', label: 'Model', help: 'One of its models', kind: 'choice', choices: { list: PROVIDER_MODELS_LIST, dependsOn: 'provider' }, required: { default: '', defaultMeans: 'its first model' }, typed: { flag: '--model' } },
  ],
  sentence: 'Every conversation that has not chosen its own model uses {provider} from the next message, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { provider: 'openai' },
  async run(values, services) {
    const models = services.models;
    const provider = values.provider!.trim();
    const listed = await models.providerApi.listModels({ providerId: provider, selectableOnly: true });
    const chosen = values.model ? listed.find((model) => model.modelId === values.model || model.registryKey === values.model) : listed[0];
    if (!chosen) {
      throw new CapabilityRefusal(values.model
        ? `${provider} has no model ${values.model} you can use; nothing was changed.`
        : `${provider} is not a provider with a model you can use; nothing was changed.`, 'The Providers list in Models and providers shows the ones that are set up.', 'NOT_FOUND');
    }
    models.configManager.set('provider.model', chosen.registryKey);
    return { text: `Every conversation that has not chosen its own model now uses ${chosen.providerId} (model ${chosen.modelId}).`, data: { model: chosen.registryKey, provider: chosen.providerId } };
  },
};

/** How a provider is signed in, in one word a list can show. */
type SignInState = 'signed-in' | 'expired' | 'expiring' | 'waiting' | 'can-sign-in' | 'none';

function signInStateOf(subscriptions: SubscriptionManager, available: ReadonlySet<string>, provider: string): { readonly state: SignInState; readonly expiresAt?: number | undefined } {
  const stored = subscriptions.get(provider);
  if (subscriptions.getPending(provider)) return { state: 'waiting' };
  if (stored) {
    if (stored.revokedAt !== undefined) return { state: 'expired', ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}) };
    if (stored.expiresAt !== undefined && stored.expiresAt <= Date.now() && !stored.refreshToken) return { state: 'expired', expiresAt: stored.expiresAt };
    if (stored.expiresAt !== undefined && stored.expiresAt <= Date.now() + 24 * 60 * 60 * 1000 && !stored.refreshToken) return { state: 'expiring', expiresAt: stored.expiresAt };
    return { state: 'signed-in', ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}) };
  }
  return { state: available.has(provider) ? 'can-sign-in' : 'none' };
}

async function accountSnapshot(models: Models): Promise<ProviderAccountSnapshot> {
  return buildProviderAccountSnapshot({
    providerRegistry: models.providerRegistry,
    serviceRegistry: models.serviceRegistry,
    subscriptionManager: models.subscriptionManager,
    secretsManager: models.secretsManager,
  });
}

/**
 * Everything Models and providers shows, in one read: the default model and
 * its backups, the models of every provider that is set up (pinned and backup
 * marked), every provider with how it is signed in, providers of your own,
 * how requests are routed, and the services.
 */
export const PROVIDER_LIST: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.list', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'see-providers', label: 'See your providers', word: 'list', inputs: [],
  sentence: 'Shows the default model, every provider you have, your subscription sign-ins and providers of your own, and how requests are routed.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const models = services.models;
    const registry = models.providerRegistry;
    const subscriptions = models.subscriptionManager;
    let defaultModel = '';
    try { defaultModel = registry.getCurrentModel().registryKey; } catch { /* nothing chosen yet */ }
    const backups = backupOrder(models);
    const favorites = await models.providerApi.getFavorites().catch(() => ({ pinned: [], recent: [] }));
    const pinned = new Set(favorites.pinned.map((entry) => entry.registryKey));
    const customDir = models.configManager.getCustomProvidersDir();
    const custom = new Set(customProviderNames(customDir));
    const servicesUnreadable = models.serviceRegistry.unreadableReason?.() ?? null;
    const availableSubscriptions = new Set(servicesUnreadable ? listBuiltinSubscriptionProviders().map((entry) => entry.provider) : listAvailableSubscriptionProviders(models.serviceRegistry.getAll()).map((entry) => entry.provider));
    let snapshot: ProviderAccountSnapshot | null = null;
    let accountsUnreadable: string | undefined;
    try { snapshot = await accountSnapshot(models); } catch (error) { accountsUnreadable = summarizeError(error); }
    const accounts = new Map((snapshot?.providers ?? []).map((record) => [record.providerId, record]));
    const allModels = await models.providerApi.listModels({ selectableOnly: true });
    const providers = registry.listProviders();
    const ids = [...new Set([...providers.map((provider) => provider.name), ...availableSubscriptions, ...custom])].sort((a, b) => a.localeCompare(b));
    const providerRows = ids.map((id) => {
      const provider = providers.find((entry) => entry.name === id);
      const setUp = provider ? isSetUp(provider) : false;
      const signIn = signInStateOf(subscriptions, availableSubscriptions, id);
      const account: ProviderAccountRecord | undefined = accounts.get(id);
      const keyNames = provider?.describeAuthState?.().authEnvVars ?? [];
      return {
        id,
        setUp,
        custom: custom.has(id),
        signIn: signIn.state,
        ...(signIn.expiresAt ? { expiresAt: signIn.expiresAt } : {}),
        models: allModels.filter((model) => model.providerId === id).length,
        inUse: defaultModel.startsWith(`${id}:`),
        ...(keyNames[0] ? { keyName: keyNames[0] } : {}),
        ...(account ? { route: account.activeRoute, freshness: account.authFreshness, issues: account.issues, notes: account.notes } : {}),
      };
    }).filter((row) => (row.setUp && row.models > 0) || row.custom || row.signIn !== 'none' || row.inUse);
    const setUpIds = new Set(providerRows.filter((row) => row.setUp || row.signIn === 'signed-in').map((row) => row.id));
    const modelRows = allModels.filter((model) => setUpIds.has(model.providerId)).map((model) => ({
      registryKey: model.registryKey,
      label: model.displayName,
      provider: model.providerId,
      contextWindow: model.contextWindow,
      // The model's own definition, as "why requests go there" reads it (the router's facts source).
      reasoning: model.capabilities.reasoning,
      isDefault: model.registryKey === defaultModel,
      backup: backups.indexOf(model.registryKey) + 1,
      pinned: pinned.has(model.registryKey),
    }));
    const routing = routeInForce(models.providerOptimizer);
    const pinnedTarget = models.providerOptimizer.pinnedTarget;
    const lines = [
      defaultModel ? `Default model: ${defaultModel} (a conversation that chose its own keeps it).` : 'No default model yet.',
      backups.length === 0 ? 'No backup model: a turn that fails stops and says why.' : `Backup models, in order: ${backups.join(', ')}.`,
      '',
      providerRows.length === 0 ? 'No provider is set up yet: add one of your own or sign in with a subscription.' : 'Providers:',
      ...providerRows.map((row) => `  ${row.inUse ? '▶' : ' '} ${row.id}${row.custom ? '  (your own)' : ''}${row.signIn === 'signed-in' ? `  (signed in with a subscription, ${row.expiresAt ? `until ${iso(row.expiresAt)}` : 'no expiry'})` : row.signIn === 'waiting' ? '  (sign-in waiting for its code)' : row.signIn === 'expired' ? '  (subscription sign-in ended)' : ''}${row.setUp ? '' : row.signIn === 'can-sign-in' ? '  (can sign in with a subscription)' : '  (not set up)'}`),
      '',
      `Requests are routed: ${routeWords(models.providerOptimizer)}.`,
      ...(servicesUnreadable ? [`Your services file could not be read (${servicesUnreadable}), so providers it adds are not listed.`] : []),
      ...(accountsUnreadable ? [`The provider accounts could not be read: ${accountsUnreadable}.`] : []),
    ];
    return {
      text: lines.join('\n'),
      data: {
        defaultModel, backups, providers: providerRows, models: modelRows, routing,
        ...(pinnedTarget ? { pinnedRoute: `${pinnedTarget.providerId}:${pinnedTarget.modelId}` } : {}),
        custom: [...custom],
        pending: subscriptions.listPending().map((pending) => ({ provider: pending.provider, startedAt: pending.createdAt })),
        stored: subscriptions.list().map((stored) => ({ provider: stored.provider, ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}) })),
        available: [...availableSubscriptions],
        ...(servicesUnreadable ? { servicesUnreadable } : {}),
        ...(accountsUnreadable ? { accountsUnreadable } : {}),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Subscription sign-ins
// ---------------------------------------------------------------------------

function precedence(record: Pick<ProviderSubscription, 'overrideAmbientApiKeys'>): string {
  return record.overrideAmbientApiKeys
    ? 'It is used before any API key you set for this provider.'
    : 'It is used for subscription routes only; an API key you set is used as before.';
}

const SUBSCRIPTION_PROVIDER: InputDescription = {
  id: 'provider', label: 'Provider', help: 'The providers that offer a subscription sign-in', kind: 'choice', choices: { list: SUBSCRIPTIONS_AVAILABLE_LIST }, required: true, typed: { position: 1 },
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Starting a sign-in is the daemon's own method (the web UI's "Sign in again" runs it too). */
export const PROVIDER_SIGN_IN: MethodCapabilityDefinition = {
  capability: { id: 'provider.sign-in', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'sign-in', label: 'Sign in (log in) with a subscription', word: 'sign-in',
  inputs: [SUBSCRIPTION_PROVIDER],
  sentence: 'A sign-in (log in) to {provider} with your subscription starts: you open the address it gives in a browser; once it finishes, the sign-in is kept for every program until you change it (signing out ends it).', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'sign-out', example: { provider: 'openai' },
  method: { id: 'providers.subscription.signIn.begin', fields: { provider: 'provider' } },
  // The sign-in address carries the sign-in's state: it is shown once, in the pane, and is not in the words or the data.
  reveals: { label: 'Sign-in address', note: 'Open it in a browser to sign in. It is shown this once: start the sign-in again for a new address.' },
  oneTime: ['authorizationUrl'],
  reveal: (answer) => (text(answer['authorizationUrl']) ? { value: text(answer['authorizationUrl']) } : undefined),
  said: (answer, values) => {
    const finish = 'When the page shows a code (or an address), give it to Finish signing in on this provider.';
    return [
      `Signing in to ${text(answer['provider']) || values.provider}. The sign-in address is shown once, in the pane: open it in a browser.`,
      ...(text(answer['listenerNote']) ? [text(answer['listenerNote'])] : []),
      answer['finishes'] === 'on-its-own' ? `A browser on the daemon's machine finishes it on its own. ${finish}` : finish,
    ].join('\n');
  },
};

/** Finishing one with the code the page showed is the daemon's own method too; the tokens stay in its stores. */
export const PROVIDER_FINISH: MethodCapabilityDefinition = {
  capability: { id: 'provider.finish', group: 'models', home: 'daemon', repeat: 'unsafe' },
  actionId: 'finish-sign-in', label: 'Finish signing in with a code', word: 'finish',
  inputs: [
    { id: 'provider', label: 'Provider', help: 'Sign-ins waiting for their code', kind: 'choice', choices: { list: SUBSCRIPTIONS_PENDING_LIST }, required: true, typed: { position: 1 } },
    { id: 'code', label: 'Code or address', help: 'The code the sign-in page showed, or the whole address it sent you to', kind: 'secret', required: true, typed: { position: 2 } },
  ],
  sentence: 'The sign-in to {provider} is finished with the code you give and kept for every program until you change it (signing out ends it).', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'sign-out', example: { provider: 'openai' },
  // A model's `/provider finish` was a judgment at v3.5.0 (class none, not owner only), and so it is now: the code is the
  // person's, typed on the hidden line, and the sign-in is theirs.
  method: { id: 'providers.subscription.signIn.finish', fields: { provider: 'provider', code: 'code' } },
  said: (answer, values) => {
    const expiresAt = typeof answer['expiresAt'] === 'number' ? answer['expiresAt'] : undefined;
    return `Signed in to ${text(answer['provider']) || values.provider} with a subscription (${text(answer['tokenType']) || 'a'} token, ${expiresAt ? `expires ${iso(expiresAt)}` : 'no expiry'}).`;
  },
};

export const PROVIDER_SIGN_OUT: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.sign-out', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'sign-out', label: 'Sign out of a subscription', word: 'sign-out',
  inputs: [{ id: 'provider', label: 'Provider', help: 'Your subscription sign-ins', kind: 'choice', choices: { list: SUBSCRIPTIONS_STORED_LIST }, required: true, typed: { position: 1 } }],
  sentence: 'Your {provider} subscription sign-in is removed from this machine, for every program, and an API key you set for it is used again, until you change it.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'sign-in', example: { provider: 'openai' },
  async run(values, services) {
    const models = services.models;
    const provider = values.provider!.trim();
    const removed = await models.subscriptionManager.logout(provider);
    if (!removed) throw new CapabilityRefusal(`There was no ${provider} subscription sign-in; nothing was changed.`, 'The Providers list in Models and providers shows your sign-ins.', 'NOT_FOUND');
    models.announce({ updated: [provider] });
    return { text: `Signed out of ${provider}. An API key you set for it is used again.`, data: { provider, signedIn: false } };
  },
};

function inspectionLines(provider: string, inspection: ProviderAuthInspection, models: Models): string[] {
  const stored = models.subscriptionManager.get(provider);
  const resolved = getSubscriptionProviderConfig(provider, models.serviceRegistry.get(provider));
  return [
    `${provider} subscription sign-in`,
    `  can sign in: ${inspection.configured ? 'yes' : 'no'}`,
    `  state: ${stored ? 'signed in' : inspection.freshness === 'pending' ? 'waiting for its code' : 'not signed in'} (${inspection.freshness})`,
    `  finishes: ${inspection.callbackMode === 'local' ? 'on its own when a browser on the daemon\'s machine comes back, or with a pasted code' : 'with a pasted code'}`,
    ...(resolved ? [`  from: ${resolved.source === 'service' ? 'your services file' : 'built in'}`, `  sign-in page: ${resolved.oauth.authUrl}`, `  returns to: ${resolved.oauth.redirectUri}`] : []),
    ...(stored ? [
      `  token: ${stored.tokenType}, ${stored.expiresAt ? `expires ${iso(stored.expiresAt)}` : 'no expiry'}, renewable: ${stored.refreshToken ? 'yes' : 'no'}`,
      `  signed in: ${iso(stored.createdAt)}, last updated ${iso(stored.updatedAt)}`,
      `  ${precedence(stored)}`,
    ] : []),
    ...inspection.issues.map((issue) => `  problem: ${issue}`),
    ...inspection.nextActions.map((step) => `  next: ${step}`),
  ];
}

async function inspection(models: Models, provider: string): Promise<ProviderAuthInspection> {
  try {
    return await inspectProviderAuth(provider, { serviceRegistry: models.serviceRegistry, subscriptionManager: models.subscriptionManager, secretsManager: models.secretsManager });
  } catch (error) {
    throw new CapabilityRefusal(`${provider}'s sign-in could not be read: ${summarizeError(error)}`, undefined, 'NOT_DONE');
  }
}

export const PROVIDER_SHOW: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.show', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'see-sign-in', label: 'See a subscription sign-in', word: 'show',
  inputs: [SUBSCRIPTION_PROVIDER],
  sentence: 'Shows {provider}\'s subscription sign-in: whether you are signed in, until when, where it comes from and what to do next.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { provider: 'openai' },
  async run(values, services) {
    const models = services.models;
    const provider = values.provider!.trim();
    const resolved = getSubscriptionProviderConfig(provider, models.serviceRegistry.get(provider));
    if (!resolved && !models.subscriptionManager.get(provider) && !models.subscriptionManager.getPending(provider)) {
      throw new CapabilityRefusal(`${provider} has no subscription sign-in, stored or available.`, 'The Providers list in Models and providers names the providers you can sign in to.', 'NOT_FOUND');
    }
    const found = await inspection(models, provider);
    return { text: inspectionLines(provider, found, models).join('\n'), data: { provider, freshness: found.freshness, signedIn: found.activeSubscription, pending: found.pendingLogin, ...(found.expiresAt ? { expiresAt: found.expiresAt } : {}) } };
  },
};

// ---------------------------------------------------------------------------
// The sign-ins file (moving sign-ins to another machine)
// ---------------------------------------------------------------------------

interface SubscriptionFile {
  readonly version: 1;
  readonly exportedAt: number;
  /** The sign-ins with their tokens as text: the file is the owner's chosen store for moving them. */
  readonly subscriptions: readonly SubscriptionGrant[];
}

/** One exported sign-in, keeping only the fields a stored session has; a refresh in flight is not carried over. */
function readFileSubscription(entry: unknown): SubscriptionGrant | null {
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

function readSubscriptionFile(path: string, caller: CapabilityCaller): SubscriptionFile {
  // Never the system's or the parser's words (capabilities/path-inputs.ts).
  const value = readCallerJson(path, 'a sign-ins file', caller);
  const candidate = value && typeof value === 'object' ? value as Partial<Record<keyof SubscriptionFile, unknown>> : {};
  const list = candidate.subscriptions;
  const subscriptions = Array.isArray(list) ? list.map(readFileSubscription) : [];
  if (candidate.version !== 1 || typeof candidate.exportedAt !== 'number' || !Number.isFinite(candidate.exportedAt) || !Array.isArray(list) || subscriptions.some((entry) => entry === null)) {
    throw new CapabilityRefusal(`${path} is not a sign-ins file (version 1, with exportedAt and a list of complete sign-ins). Nothing was changed.`, undefined, 'BUNDLE_UNREADABLE', 422);
  }
  return { version: 1, exportedAt: candidate.exportedAt, subscriptions: subscriptions as SubscriptionGrant[] };
}

/** What loading `file` would do to each provider: add a sign-in or replace the stored one. */
function describeLoad(manager: SubscriptionManager, file: SubscriptionFile): string[] {
  return file.subscriptions.map((subscription) => {
    const current = manager.get(subscription.provider);
    const expires = subscription.expiresAt ? `expires ${iso(subscription.expiresAt)}` : 'no expiry';
    return current
      ? `  ${subscription.provider}  replaces the stored sign-in (updated ${iso(current.updatedAt)}) with one updated ${iso(subscription.updatedAt)}, ${expires}`
      : `  ${subscription.provider}  adds a sign-in, ${expires}`;
  });
}

/** Write `text` to `target` owner-only; with `replace` false an existing file is never written over. */
function writeOwnerOnlyFile(target: string, text: string, replace: boolean, shown: string): void {
  if (replace) {
    atomicWriteFileSync(target, text, { mkdirp: true });
    chmodSync(target, 0o600);
    return;
  }
  // The check is the write itself: an existing file, even one made a moment ago, is never replaced.
  mkdirSync(dirname(target), { recursive: true });
  let fd: number;
  try {
    fd = openSync(target, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CapabilityRefusal(`${shown} already exists; nothing was written.`, 'Choose "Write over it" to replace it.');
    throw error;
  }
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(target, { force: true });
    throw error;
  }
  closeSync(fd);
}

export const PROVIDER_EXPORT: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.export', group: 'models', home: 'daemon', repeat: 'unsafe' },
  actionId: 'save-sign-ins', label: 'Save your sign-ins to a file', word: 'export',
  inputs: [{ ...pathInput('Where to write them, such as sign-ins.json'), file: 'written' }, REPLACE_INPUT],
  sentence: 'Your subscription sign-ins (logins), with their tokens, are written to {path} to copy to another machine or laptop, and stay there until you change it: anyone who reads the file can use them, so delete it once it has been used.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection',
  ownerOnly: { reason: 'it writes your sign-in tokens out of the secret store into a plain file', instead: `Ask the owner to save them from ${PLACE}.` },
  // The file it writes holds working sign-in tokens.
  resultSecret: 'your sign-in tokens',
  example: { path: 'sign-ins.json' },
  async run(values, services, caller) {
    const models = services.models;
    const target = filePath(models, caller, values.path!);
    const file: SubscriptionFile = { version: 1, exportedAt: Date.now(), subscriptions: models.subscriptionManager.list().map(subscriptionExportForm) };
    writeOwnerOnlyFile(target, `${JSON.stringify(file, null, 2)}\n`, values.replace === 'yes', values.path!);
    return { text: `Wrote ${file.subscriptions.length} sign-in${file.subscriptions.length === 1 ? '' : 's'} to ${target}. The file holds working sign-in tokens: keep it private and delete it after use.`, data: { path: target, count: file.subscriptions.length } };
  },
};

export const PROVIDER_INSPECT: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.inspect', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'check-sign-ins', label: 'Check a sign-ins file', word: 'inspect',
  inputs: [pathInput('A file your sign-ins were saved to')],
  sentence: 'Shows the sign-ins {path} holds and what loading it would add or replace, without changing anything.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { path: 'sign-ins.json' },
  async run(values, services, caller) {
    const models = services.models;
    const target = filePath(models, caller, values.path!);
    const file = readSubscriptionFile(target, caller);
    return {
      text: [`${target}: ${file.subscriptions.length} sign-in${file.subscriptions.length === 1 ? '' : 's'}, written ${iso(file.exportedAt)}.`, 'Loading it would:', ...describeLoad(models.subscriptionManager, file)].join('\n'),
      data: { path: target, providers: file.subscriptions.map((entry) => entry.provider) },
    };
  },
};

export const PROVIDER_IMPORT: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.import', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'load-sign-ins', label: 'Load sign-ins from a file', word: 'import',
  inputs: [pathInput('A file your sign-ins were saved to')],
  sentence: 'The sign-ins in {path} are kept on this machine for every program, each replacing any stored sign-in for the same provider.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
  // It stores the file's sign-in tokens: writing a credential.
  effects: ['control-plane.write', 'secret.write'],
  example: { path: 'sign-ins.json' },
  async run(values, services, caller) {
    const models = services.models;
    const target = filePath(models, caller, values.path!);
    const file = readSubscriptionFile(target, caller);
    if (file.subscriptions.length === 0) throw new CapabilityRefusal(`${target} holds no sign-ins; nothing was changed.`, undefined, 'BUNDLE_EMPTY');
    const lines = describeLoad(models.subscriptionManager, file);
    for (const subscription of file.subscriptions) await models.subscriptionManager.saveSubscription(subscription);
    models.announce({ updated: file.subscriptions.map((entry) => entry.provider) });
    return { text: [`Loaded ${file.subscriptions.length} sign-in${file.subscriptions.length === 1 ? '' : 's'} from ${target}:`, ...lines].join('\n'), data: { path: target, providers: file.subscriptions.map((entry) => entry.provider) } };
  },
};

// ---------------------------------------------------------------------------
// Providers of your own
// ---------------------------------------------------------------------------

export const PROVIDER_ADD: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.add', group: 'models', home: 'daemon', repeat: 'unsafe' },
  actionId: 'add', label: 'Add a provider of your own', word: 'add',
  inputs: [
    { id: 'name', label: 'Name', help: 'What it is called: letters, numbers, - and _', kind: 'text', freeTextReason: 'a name you choose', required: true, typed: { position: 1 } },
    { id: 'address', label: 'Address', help: 'Where your server answers, such as http://127.0.0.1:8080/v1', kind: 'text', freeTextReason: 'the address of a server you run', required: true, typed: { position: 2 } },
    { id: 'key', label: 'API key', help: 'Hidden as you type; leave it empty when the server needs none', kind: 'secret', required: { default: '', defaultMeans: 'no key' }, typed: { flag: '--key' } },
  ],
  sentence: '{name} is added for every program with the models {address} lists, and a key you give is kept in the daemon\'s secret store, until you change it.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove',
  // Storing the key it is given is writing a credential.
  effects: ['control-plane.write', 'secret.write'],
  example: { name: 'my-server', address: 'http://192.168.0.85:8001/v1' },
  async run(values, services) {
    const models = services.models;
    const added = await addCustomProvider(
      { name: values.name!.trim(), address: values.address!.trim(), apiKey: values.key || undefined, directory: models.configManager.getCustomProvidersDir(), codeEditing: true },
      models.secretsManager,
    );
    models.announce({ added: [values.name!.trim()] });
    return { text: added.text, data: { provider: values.name!.trim(), models: added.models } };
  },
};

export const PROVIDER_REMOVE: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'provider.remove', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'remove', label: 'Remove a provider of your own', word: 'remove',
  inputs: [{ id: 'name', label: 'Provider', help: 'The providers you added', kind: 'choice', choices: { list: CUSTOM_PROVIDERS_LIST }, required: true, typed: { position: 1 } }],
  sentence: '{name}\'s provider file and its stored key are deleted, and its models leave the list in every program.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone', example: { name: 'my-server' },
  async run(values, services) {
    const models = services.models;
    const name = values.name!.trim();
    const text = await removeCustomProvider(name, models.configManager.getCustomProvidersDir(), models.secretsManager);
    models.announce({ removed: [name] });
    return { text, data: { provider: name } };
  },
};

// ---------------------------------------------------------------------------
// Provider accounts (how each provider is reached)
// ---------------------------------------------------------------------------

const ACCOUNT_PROVIDER: InputDescription = {
  id: 'provider', label: 'Provider', help: 'The model providers you have', kind: 'choice', choices: { list: ACCOUNT_PROVIDERS_LIST }, required: true, typed: { position: 1 },
};

/** The provider records of an `accounts.snapshot` answer, read defensively (it is data from the daemon's method). */
function accountRecords(answer: Readonly<Record<string, unknown>>): readonly ProviderAccountRecord[] {
  const providers = answer['providers'];
  return Array.isArray(providers) ? providers.filter((entry): entry is ProviderAccountRecord => entry !== null && typeof entry === 'object' && typeof (entry as { providerId?: unknown }).providerId === 'string') : [];
}

/** One record by provider, or the sentence that none is named so. */
function accountIn(answer: Readonly<Record<string, unknown>>, provider: string | undefined): ProviderAccountRecord | string {
  const record = accountRecords(answer).find((entry) => entry.providerId === provider);
  return record ?? `No provider account is named ${provider ?? '(none given)'}; the Providers list in Models and providers shows them.`;
}

const list = <T>(value: readonly T[] | undefined): readonly T[] => (Array.isArray(value) ? value : []);

function routeRecordLine(route: ProviderAccountRecord['routeRecords'][number]): string {
  return `${route.route}  ${route.usable ? 'usable' : 'blocked'}  sign-in ${route.freshness}  ${route.detail}`;
}

/** The provider accounts are the daemon's `accounts.snapshot`; each of these words one part of its answer. */
const SNAPSHOT_METHOD = { id: 'accounts.snapshot', fields: {} } as const;

export const ACCOUNTS_REVIEW: MethodCapabilityDefinition = {
  capability: { id: 'accounts.review', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'see-accounts', label: 'See your provider accounts', word: 'review', inputs: [],
  sentence: 'Shows each model provider, how it is reached now and which way is preferred, how fresh its sign-in is, and anything wrong.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  method: SNAPSHOT_METHOD,
  said: (answer) => {
    const records = accountRecords(answer);
    const configured = records.filter((record) => record.configured).length;
    return [
      `Provider accounts: ${records.length}, ${configured} set up, ${records.filter((record) => list(record.issues).length > 0).length} with something wrong.`,
      ...records.map((record) => `  ${record.providerId}  reached by ${record.activeRoute} (preferred ${record.preferredRoute})  sign-in ${record.authFreshness}  ${record.modelCount} models${list(record.issues).length > 0 ? `  ${list(record.issues).length} problem${list(record.issues).length === 1 ? '' : 's'}` : ''}`),
      ...(typeof answer['servicesUnreadable'] === 'string' ? [`Your services file could not be read: ${answer['servicesUnreadable']}.`] : []),
    ].join('\n');
  },
};

export const ACCOUNTS_SHOW: MethodCapabilityDefinition = {
  capability: { id: 'accounts.show', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'see-account', label: 'See one provider\'s account', word: 'show', inputs: [ACCOUNT_PROVIDER],
  sentence: 'Shows {provider}\'s account: each way it can be reached, its sign-in, usage windows and what to do next.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { provider: 'openai' },
  method: SNAPSHOT_METHOD,
  said: (answer, values) => {
    const record = accountIn(answer, values.provider);
    if (typeof record === 'string') return record;
    return [
      `${record.providerId}: reached by ${record.activeRoute} (preferred ${record.preferredRoute}), sign-in ${record.authFreshness}, ${record.configured ? 'set up' : 'not set up'}, ${record.modelCount} models`,
      `  why that way: ${record.activeRouteReason}`,
      ...(record.pendingLogin ? ['  a subscription sign-in is waiting for its code'] : []),
      ...(record.fallbackRoute ? [`  if that fails: ${record.fallbackRoute}`] : []),
      ...(record.fallbackRisk ? [`  routing risk: ${record.fallbackRisk}`] : []),
      ...(record.expiresAt ? [`  sign-in ends: ${iso(record.expiresAt)}`] : []),
      ...list(record.routeRecords).map((route) => `  way: ${routeRecordLine(route)}`),
      ...list(record.routeRecords).flatMap((route) => list(route.issues).map((issue) => `    problem: ${issue}`)),
      ...list(record.usageWindows).map((entry) => `  usage window: ${entry.label}, ${entry.detail}`),
      ...list(record.issues).map((issue) => `  problem: ${issue}`),
      ...list(record.notes).map((note) => `  note: ${note}`),
      ...list(record.recommendedActions).map((action) => `  next: ${action.description}`),
    ].join('\n');
  },
};

export const ACCOUNTS_ROUTES: MethodCapabilityDefinition = {
  capability: { id: 'accounts.routes', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'see-routes', label: 'See how a provider is reached', word: 'routes', inputs: [ACCOUNT_PROVIDER],
  sentence: 'Shows each way {provider} can be reached (a key, a subscription, a local server), whether it works, and why one is used.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { provider: 'openai' },
  method: SNAPSHOT_METHOD,
  said: (answer, values) => {
    const record = accountIn(answer, values.provider);
    if (typeof record === 'string') return record;
    return [
      `${record.providerId}: reached by ${record.activeRoute}, preferred ${record.preferredRoute}`,
      `  why: ${record.activeRouteReason}`,
      ...list(record.routeRecords).map((route) => `  ${routeRecordLine(route)}`),
      ...list(record.routeRecords).flatMap((route) => list(route.issues).map((issue) => `    problem: ${issue}`)),
    ].join('\n');
  },
};

export const ACCOUNTS_REPAIR: MethodCapabilityDefinition = {
  capability: { id: 'accounts.repair', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'fix-account', label: 'See how to fix a provider\'s account', word: 'repair', inputs: [ACCOUNT_PROVIDER],
  sentence: 'Shows what is wrong with {provider}\'s account and the steps that fix it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { provider: 'openai' },
  method: SNAPSHOT_METHOD,
  said: (answer, values) => {
    const record = accountIn(answer, values.provider);
    if (typeof record === 'string') return record;
    return [
      `${record.providerId}: reached by ${record.activeRoute}, preferred ${record.preferredRoute}`,
      ...(record.fallbackRisk ? [`  routing risk: ${record.fallbackRisk}`] : []),
      ...(list(record.issues).length === 0 ? ['  Nothing is wrong with it.'] : list(record.issues).map((issue) => `  problem: ${issue}`)),
      ...(list(record.recommendedActions).length > 0 ? ['  what fixes it:', ...list(record.recommendedActions).map((action) => `    ${action.description}`)] : []),
    ].join('\n');
  },
};

// ---------------------------------------------------------------------------
// Provider sign-ins (the summary for a support thread)
// ---------------------------------------------------------------------------

const AUTH_PROVIDER: InputDescription = {
  id: 'provider', label: 'Provider', help: 'Providers you can sign in to with a subscription', kind: 'choice',
  choices: { list: AUTH_PROVIDERS_LIST, allowOther: { reason: 'a provider a services file adds' } }, required: true, typed: { position: 1 },
};

function authQuery(models: Models) {
  return { serviceRegistry: models.serviceRegistry, subscriptionManager: models.subscriptionManager, secretsManager: models.secretsManager };
}

export const AUTH_REVIEW: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'auth.review', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'see-sign-ins', label: 'See your provider sign-ins', word: 'review', inputs: [],
  sentence: 'Shows each provider you can sign in to, whether you are signed in, and when it ends.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    let snapshot;
    try {
      snapshot = await buildAuthInspectionSnapshot(authQuery(services.models));
    } catch (error) {
      throw new CapabilityRefusal(`Could not read your provider sign-ins: ${summarizeError(error)}`);
    }
    const named = new Set(snapshot.providers.map((entry) => entry.provider));
    const builtin = listBuiltinSubscriptionProviders().map((entry) => entry.provider).filter((provider) => !named.has(provider));
    return {
      text: [
        `Sign-ins: ${snapshot.activeSubscriptions} signed in, ${snapshot.pendingSubscriptions} waiting for a code; ${snapshot.secretKeyCount} secrets stored.`,
        ...snapshot.providers.map((entry) => `  ${entry.provider}: ${entry.freshness}${entry.expiresAt ? `, ends ${iso(entry.expiresAt)}` : ''}${entry.issues.length > 0 ? `; ${entry.issues.join(' ')}` : ''}`),
        ...builtin.map((provider) => `  ${provider}: not signed in`),
        ...(snapshot.servicesUnreadable ? [`Your services file could not be read: ${snapshot.servicesUnreadable}.`] : []),
      ].join('\n'),
      data: { providers: snapshot.providers.map((entry) => ({ provider: entry.provider, freshness: entry.freshness, ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}) })), notSignedIn: builtin },
    };
  },
};

export const AUTH_SHOW: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'auth.show', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'see-sign-in', label: 'See one provider\'s sign-in', word: 'show', inputs: [AUTH_PROVIDER],
  sentence: 'Shows how {provider} is signed in: where its settings come from, the token\'s type and end, and anything wrong; no token is shown.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { provider: 'openai' },
  async run(values, services) {
    const provider = values.provider!.trim();
    const found = await inspection(services.models, provider);
    return {
      text: [
        `${provider}: ${found.freshness}${found.configured ? '' : ' (no sign-in is set up for it)'}`,
        ...(found.source ? [`  from: ${found.source === 'service' ? 'your services file' : 'built in'}`] : []),
        `  finishes: ${found.callbackMode === 'local' ? `on its own at ${found.localCallback ?? 'this machine'}` : 'with a pasted code'}`,
        ...(found.tokenType ? [`  token type: ${found.tokenType}`] : []),
        ...(found.expiresAt ? [`  ends: ${iso(found.expiresAt)}`] : []),
        ...found.issues.map((issue) => `  problem: ${issue}`),
      ].join('\n'),
      data: { provider, freshness: found.freshness, configured: found.configured },
    };
  },
};

export const AUTH_REPAIR: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'auth.repair', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'fix-sign-in', label: 'See how to fix a provider\'s sign-in', word: 'repair', inputs: [AUTH_PROVIDER],
  sentence: 'Shows what is wrong with {provider}\'s sign-in and the steps that fix it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { provider: 'openai' },
  async run(values, services) {
    const provider = values.provider!.trim();
    const found = await inspection(services.models, provider);
    return {
      text: [
        `${provider}: ${found.freshness}`,
        ...(found.issues.length === 0 ? ['  Nothing is wrong with it.'] : found.issues.map((issue) => `  problem: ${issue}`)),
        ...found.nextActions.map((step) => `  next: ${step}`),
      ].join('\n'),
      data: { provider, issues: found.issues, steps: found.nextActions },
    };
  },
};

export const AUTH_EXPORT: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'auth.export', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'save-summary', label: 'Save a sign-in summary to a file', word: 'export',
  inputs: [{ ...pathInput('A path in this project, or an absolute path'), file: 'written' }, REPLACE_INPUT],
  sentence: 'A summary of your sign-ins (names of stored secrets and providers, no secret or token) will be written to {path}, readable by you only, until you change it.',
  done: 'Saved the sign-in summary to {path}.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'auth-summary.json' },
  async run(values, services, caller) {
    const models = services.models;
    const target = filePath(models, caller, values.path!);
    if (existsSync(target) && values.replace !== 'yes') throw new CapabilityRefusal(`${target} already exists; nothing was written.`, 'Choose "Write over it" to replace it.');
    const bundle = {
      version: 1 as const,
      exportedAt: Date.now(),
      secretKeys: await models.secretsManager.list(),
      activeSubscriptions: models.subscriptionManager.list().map((entry) => entry.provider),
      pendingSubscriptions: models.subscriptionManager.listPending().map((entry) => entry.provider),
    };
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, JSON.stringify(bundle, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    // The mode above applies only when the file is created; one written over must still end owner-only.
    chmodSync(target, 0o600);
    return { text: target === values.path ? '' : `Written to ${target}.`, data: { path: target } };
  },
};

export const AUTH_INSPECT: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'auth.inspect', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'read-summary', label: 'Read a saved sign-in summary', word: 'inspect', inputs: [pathInput('A path in this project, or an absolute path')],
  sentence: 'Shows what the sign-in summary in {path} holds.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { path: 'auth-summary.json' },
  async run(values, services, caller) {
    const target = filePath(services.models, caller, values.path!);
    // Never the system's or the parser's words (capabilities/path-inputs.ts).
    const value = readCallerJson(target, 'a sign-in summary', caller, 'Nothing was read from it.');
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    if (record['version'] !== 1) throw new CapabilityRefusal(`${target} is not a sign-in summary (version 1).`);
    const names = (key: string) => stringList(record[key]);
    return {
      text: [
        `${target}: written ${typeof record['exportedAt'] === 'number' ? iso(record['exportedAt']) : 'at an unknown time'}`,
        `  secrets stored: ${names('secretKeys').length} (${names('secretKeys').join(', ') || 'none'})`,
        `  signed in: ${names('activeSubscriptions').join(', ') || 'none'}`,
        `  waiting for a code: ${names('pendingSubscriptions').join(', ') || 'none'}`,
      ].join('\n'),
      data: { path: target, secretKeys: names('secretKeys'), signedIn: names('activeSubscriptions'), waiting: names('pendingSubscriptions') },
    };
  },
};

// ---------------------------------------------------------------------------
// Media providers
// ---------------------------------------------------------------------------

export const MEDIA_PROVIDERS: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'media.providers', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'providers', label: 'See the media providers', word: 'providers', inputs: [],
  sentence: 'Lists the media providers, what each makes, and whether each is set up.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const statuses = await services.models.mediaProviders.status();
    if (statuses.length === 0) return { text: 'No media providers are registered in this build.', data: { providers: [] } };
    return {
      text: ['Media providers:', ...statuses.map((status) => {
        const outputs = Array.isArray(status.metadata['outputs']) ? ` (makes ${(status.metadata['outputs'] as unknown[]).join(', ')})` : '';
        return `  ${status.id}: ${status.state}${status.configured ? '' : ', setup needed'}${outputs}; ${status.capabilities.join(', ')}${status.detail ? `; ${status.detail}` : ''}`;
      })].join('\n'),
      // With what each does and makes: a form choosing a provider that makes media lists only those (terminal-shell places/tools-lists.ts).
      data: { providers: statuses.map((status) => ({ id: status.id, label: status.label, state: status.state, configured: status.configured, capabilities: [...status.capabilities],
        ...(Array.isArray(status.metadata['outputs']) ? { outputs: (status.metadata['outputs'] as unknown[]).filter((output): output is string => typeof output === 'string') } : {}),
        // The name its key is stored under (the Media tab's "store its key"); never the key.
        ...(Array.isArray(status.metadata['keyNames']) && typeof status.metadata['keyNames'][0] === 'string' ? { keyName: status.metadata['keyNames'][0] } : {}) })) },
    };
  },
};

/** Model servers on this computer (Ollama, LM Studio and the like), found by the daemon and added to the providers. */
export const MODELS_SCAN: CapabilityDefinition<ModelsCapabilityServices> = {
  capability: { id: 'models.scan', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'scan', label: 'Find model servers on this computer', word: 'scan', inputs: [],
  sentence: 'Looks for model servers running on this computer (Ollama, LM Studio, a local llama server and the like) and adds each one found to your providers for every program, until you change it. Your local network is scanned from Devices and network.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: {},
  async run(_values, services) {
    const { found, skipped, durationMs } = await services.models.scanThisComputer();
    const seconds = Math.max(1, Math.round(durationMs / 1000));
    const lines = found.length === 0
      ? [`No model server answered on this computer (looked for ${seconds}s).`]
      : [
          `Found ${found.length} model server${found.length === 1 ? '' : 's'} on this computer, added to your providers:`,
          ...found.map((server) => `  ${server.name}: ${server.models.length} model${server.models.length === 1 ? '' : 's'} at port ${server.port}`),
          'Their models are in the Models list of Models and providers.',
        ];
    if (skipped.length > 0) lines.push(`${skipped.length} answered but were left out:`, ...skipped.map((server) => `  port ${server.port}: ${server.reason}`));
    if (found.length > 0) services.models.announce({ added: found.map((server) => server.name) });
    return {
      text: lines.join('\n'),
      data: { found: found.map((server) => ({ name: server.name, port: server.port, models: server.models.length })), skipped: skipped.length },
    };
  },
};

// ---------------------------------------------------------------------------
// The shared default model, and the model lists (the daemon's own methods)
// ---------------------------------------------------------------------------

interface ListedModel { readonly registryKey?: unknown; readonly label?: unknown; readonly id?: unknown }
interface ListedProvider { readonly id?: unknown; readonly configured?: unknown; readonly models?: unknown }

export const MODEL_LIST: MethodCapabilityDefinition = {
  capability: { id: 'model.list', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'see-models', label: 'See your model and the others you can use', word: 'list', inputs: [],
  sentence: 'Shows the default model and every model you can switch to, by provider.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  method: { id: 'models.list', fields: {} },
  said: (answer) => {
    const current = answer['currentModel'] as { readonly registryKey?: unknown } | null | undefined;
    const providers = (Array.isArray(answer['providers']) ? answer['providers'] : []) as readonly ListedProvider[];
    const usable = providers.filter((provider) => provider.configured === true);
    const lines = usable.flatMap((provider) => (Array.isArray(provider.models) ? provider.models as readonly ListedModel[] : [])
      .map((model) => `  ${text(model.registryKey).padEnd(36)} ${text(model.label) || text(model.id)} (${text(provider.id)})`));
    return [
      text(current?.registryKey) ? `Default model: ${text(current?.registryKey)}` : 'No default model yet: choose one in Models and providers.',
      '',
      lines.length === 0 ? 'No model can be chosen yet: add a provider of your own or sign in with a subscription in Models and providers.' : 'Models you can switch to:',
      ...lines,
    ].join('\n');
  },
};

export const MODEL_USE: MethodCapabilityDefinition = {
  capability: { id: 'model.use', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'use', label: 'Use a model by default', word: 'use',
  inputs: [modelInput('The model to use from now on, such as a Claude, GPT or local model')],
  sentence: 'Every conversation that has not chosen its own model uses {model} from the next message, in every program, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { model: 'openai:gpt-5' },
  method: { id: 'models.current.set', fields: { registryKey: 'model' } },
  said: (answer, values) => {
    const model = answer['model'] as { readonly registryKey?: unknown } | null | undefined;
    const key = text(model?.registryKey) || values.model;
    return `${key} is the default model now${answer['persisted'] === false ? ', for as long as the daemon runs (the setting could not be saved)' : ''}.`;
  },
};

interface RefreshReport { readonly providerId?: unknown; readonly label?: unknown; readonly models?: unknown; readonly source?: unknown; readonly error?: unknown; readonly notAsked?: unknown; readonly added?: unknown; readonly removed?: unknown }

export const MODEL_REFRESH: MethodCapabilityDefinition = {
  capability: { id: 'model.refresh', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'refresh', label: 'Read the list of models again', word: 'refresh', inputs: [],
  sentence: 'Asks every provider you have set up for its models again and says for each how many it has or why its list could not be read.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'none', example: {},
  method: { id: 'models.refresh', fields: {} },
  said: (answer) => {
    const reports = (Array.isArray(answer['providers']) ? answer['providers'] : []) as readonly RefreshReport[];
    const asked = reports.filter((report) => report.notAsked !== true);
    const notAsked = reports.length - asked.length;
    if (asked.length === 0) return 'No provider is set up yet, so there is no list to read: add one of your own or sign in with a subscription in Models and providers.';
    return [`Models by provider (${asked.length} asked${notAsked > 0 ? `; ${notAsked} more not asked, they have no key or sign-in yet` : ''}):`, ...asked.map((report) => {
      const name = text(report.label) || text(report.providerId);
      const count = typeof report.models === 'number' ? report.models : 0;
      const models = `${count} model${count === 1 ? '' : 's'}`;
      if (text(report.error)) return `  ${name}: ${text(report.error)} (${count === 0 ? 'no models' : models})`;
      const added = Array.isArray(report.added) ? report.added.length : 0;
      const removed = Array.isArray(report.removed) ? report.removed.length : 0;
      const changes = [added > 0 ? `${added} new` : '', removed > 0 ? `${removed} retired` : ''].filter(Boolean).join(', ');
      return `  ${name}: ${count === 0 ? 'no models: it answered with an empty list' : `${models}${report.source === 'live' ? ' found' : ' from its last list'}`}${changes ? ` (${changes})` : ''}`;
    })].join('\n');
  },
};

/** Every model and provider capability the daemon runs by its own handler, with the command each answered to as a slash command. */
export const MODELS_CAPABILITIES: readonly { readonly definition: CapabilityDefinition<ModelsCapabilityServices>; readonly command: { readonly name: string; readonly title: string } }[] = [
  ...[MODEL_BACKUP, MODEL_DROP_BACKUP].map((definition) => ({ definition, command: { name: 'model', title: 'Model' } })),
  ...[PIN_LIST, PIN_ADD, PIN_REMOVE].map((definition) => ({ definition, command: { name: 'pin', title: 'Pinned models' } })),
  ...[PROVIDER_LIST, PROVIDER_USE, PROVIDER_SIGN_OUT, PROVIDER_SHOW, PROVIDER_ADD, PROVIDER_REMOVE,
    PROVIDER_ROUTE, PROVIDER_PIN_ROUTE, PROVIDER_EXPLAIN, PROVIDER_FALLBACK, PROVIDER_EXPORT, PROVIDER_INSPECT, PROVIDER_IMPORT]
    .map((definition) => ({ definition, command: { name: 'provider', title: 'Providers' } })),
  ...[AUTH_REVIEW, AUTH_SHOW, AUTH_REPAIR, AUTH_EXPORT, AUTH_INSPECT].map((definition) => ({ definition, command: { name: 'auth', title: 'Provider sign-ins' } })),
  { definition: MEDIA_PROVIDERS, command: { name: 'media', title: 'Images and video' } },
  { definition: MODELS_SCAN, command: { name: 'scan', title: 'Find local model servers' } },
];

/** The model and provider capabilities that run through a daemon method of their own (method-capability.ts). */
export const MODELS_METHOD_CAPABILITIES: readonly { readonly definition: MethodCapabilityDefinition; readonly command: { readonly name: string; readonly title: string } }[] = [
  ...[MODEL_LIST, MODEL_USE, MODEL_REFRESH].map((definition) => ({ definition, command: { name: 'model', title: 'Model' } })),
  ...[PROVIDER_SIGN_IN, PROVIDER_FINISH].map((definition) => ({ definition, command: { name: 'provider', title: 'Providers' } })),
  ...[ACCOUNTS_REVIEW, ACCOUNTS_SHOW, ACCOUNTS_ROUTES, ACCOUNTS_REPAIR].map((definition) => ({ definition, command: { name: 'accounts', title: 'Accounts' } })),
];

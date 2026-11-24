/**
 * `/provider`, described once (command-actions/) for both terminal apps: where
 * your models come from and how you are signed in to them. Switching provider,
 * providers of your own, signing in with a subscription (and moving those
 * sign-ins to another machine), and how requests are routed between providers
 * are its actions. Signing in to a GoodVibes daemon or listener is `/accounts`.
 * Each app says how it reaches its services and whether its sign-in waits for
 * the browser to come back (the Agent always finishes with a pasted code).
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  atomicWriteFileSync,
  getSubscriptionProviderConfig,
  listAvailableSubscriptionProviders,
  subscriptionExportForm,
  beginSubscriptionSignIn,
  finishSubscriptionSignIn,
  type SubscriptionSignInDeps,
  type ConfigManager,
  type ProviderSubscription,
  type SecretsManager,
  type SubscriptionGrant,
  type SubscriptionManager,
} from '@goodvibes/engine/platform/platform/config';
import type { ProviderApi, ProviderOptimizer, ProviderRegistry, RouteExplanation } from '@goodvibes/engine/platform/platform/providers';
import { formatProviderModel } from '@goodvibes/engine/platform/platform/providers/provider-model';
import { inspectProviderAuth } from '@goodvibes/engine/platform/platform/runtime/security';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { openExternalUrl, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { readRefusal } from '@goodvibes/engine/errors';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, CommandDescription, FixedChoice, InputDescription } from './command-actions/types.js';
import { choiceInput, listInput, readAction, textInput } from './described-command-kit.js';
import { addCustomProvider, customProviderNames, removeCustomProvider } from './local-provider-commands.js';
import { MODELS_LIST } from './model-command.js';

type AuthDeps = Parameters<typeof inspectProviderAuth>[1];

export interface ProviderCommandContext extends CommandActionContext {
  readonly session: { readonly runtime: { model: string; provider: string } };
  readonly provider: { readonly providerOptimizer?: ProviderOptimizer | undefined; readonly providerRegistry: Pick<ProviderRegistry, 'listProviders'> };
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'set' | 'setDynamic'> };
  readonly openModal?: ((name: string) => void) | undefined;
}

/** How one app reaches what `/provider` works on. */
export interface ProviderCommandServices<Ctx extends ProviderCommandContext> {
  readonly requireProviderApi: (ctx: Ctx) => ProviderApi;
  readonly requireShellPaths: (ctx: Ctx) => ShellPathService;
  readonly requireSecretsManager: (ctx: Ctx) => Pick<SecretsManager, 'set' | 'delete'> & NonNullable<AuthDeps['secretsManager']>;
  readonly requireSubscriptionManager: (ctx: Ctx) => SubscriptionManager;
  readonly requireServiceRegistry: (ctx: Ctx) => NonNullable<AuthDeps['serviceRegistry']>;
  /** Runs `complete` once the provider is ready to use (the terminal app asks for a missing key first); always exactly once. */
  readonly beforeSelection: (ctx: Ctx, providerId: string, complete: () => void) => void;
  /** Where this app keeps its own files (`tui`, `agent`). */
  readonly surfaceRoot: string;
  /** Whether a sign-in may wait for the browser to come back to this machine; false always finishes with a pasted code. */
  readonly signInListens: boolean;
  /** Whether models of a provider of your own may edit code. */
  readonly codeEditing: boolean;
  /** How a subscription provider's source (built in, your services file) is named. */
  readonly formatSource: (source: string) => string;
}

let installed: ProviderCommandServices<ProviderCommandContext> | undefined;
function host(): ProviderCommandServices<ProviderCommandContext> {
  if (!installed) throw commandRefusal('Providers are not available in this session.');
  return installed;
}
function customDirectory(ctx: ProviderCommandContext): string {
  return host().requireShellPaths(ctx).resolveUserPath(host().surfaceRoot, 'providers');
}
function iso(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString() : 'no expiry';
}

// ---------------------------------------------------------------------------
// Live lists
// ---------------------------------------------------------------------------

const PROVIDERS = defineList<ProviderCommandContext>({
  name: 'providers',
  async read(ctx) {
    return host().requireProviderApi(ctx).listProviderIds().map((id): ListRow => ({ value: id, label: id, ...(id === ctx.session.runtime.provider ? { state: 'in use' } : {}) }));
  },
  operator: { method: 'models.list', input: {}, rows: { from: 'providers', value: 'id', label: 'label' } },
});

const PROVIDER_MODELS = defineList<ProviderCommandContext>({
  name: 'providers.models',
  async read(ctx, earlier) {
    if (!earlier.provider) return [];
    const models = await host().requireProviderApi(ctx).listModels({ providerId: earlier.provider, selectableOnly: true });
    return models.map((model): ListRow => ({ value: model.modelId, label: model.displayName, ...(model.current ? { state: 'in use' } : {}) }));
  },
  operator: { method: 'models.list', input: {}, rows: { from: 'providers', where: { field: 'id', equals: '{provider}' }, each: 'models', value: 'id', label: 'label' } },
});

const CUSTOM = defineList<ProviderCommandContext>({
  name: 'providers.custom',
  async read(ctx) {
    return customProviderNames(customDirectory(ctx)).map((name): ListRow => ({ value: name, label: name }));
  },
  operator: { terminalOnly: 'Providers of your own are files of the terminal app that added them.' },
});

/** Why these actions run in a terminal app: the sign-ins they read or move are kept on the daemon's machine. */
const SIGN_IN_TERMINAL_ONLY = 'Subscription sign-ins are kept on the daemon\'s machine; this is done from a terminal app there.';
/** Starting and finishing a sign-in is also offered by the web app, through its own daemon methods. */
const SIGN_IN_ALSO_WEB = 'This command runs in a terminal app; any client of the daemon, the web app among them, starts and finishes a sign-in with providers.subscription.signIn.begin and providers.subscription.signIn.finish.';

const SUBSCRIPTION_PROVIDERS = defineList<ProviderCommandContext>({
  name: 'subscriptions.available',
  async read(ctx) {
    const manager = host().requireSubscriptionManager(ctx);
    return listAvailableSubscriptionProviders(host().requireServiceRegistry(ctx).getAll()).map((entry): ListRow => {
      const stored = manager.get(entry.provider);
      return {
        value: entry.provider,
        label: entry.displayName || entry.provider,
        ...(stored ? { state: `signed in, ${stored.expiresAt ? `until ${iso(stored.expiresAt)}` : 'no expiry'}` } : manager.getPending(entry.provider) ? { state: 'waiting for its code' } : {}),
      };
    });
  },
  operator: { terminalOnly: SIGN_IN_TERMINAL_ONLY },
});

const PENDING = defineList<ProviderCommandContext>({
  name: 'subscriptions.pending',
  async read(ctx) {
    return host().requireSubscriptionManager(ctx).listPending().map((pending): ListRow => ({ value: pending.provider, label: pending.provider, detail: `started ${new Date(pending.createdAt).toISOString()}` }));
  },
  operator: { terminalOnly: SIGN_IN_TERMINAL_ONLY },
});

const STORED = defineList<ProviderCommandContext>({
  name: 'subscriptions.stored',
  async read(ctx) {
    return host().requireSubscriptionManager(ctx).list().map((stored): ListRow => ({ value: stored.provider, label: stored.provider, detail: stored.expiresAt ? `until ${iso(stored.expiresAt)}` : 'no expiry' }));
  },
  operator: { terminalOnly: SIGN_IN_TERMINAL_ONLY },
});

// ---------------------------------------------------------------------------
// Subscriptions: sign-in, sign-out, and the sign-ins file
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

function readSubscriptionFile(path: string): SubscriptionFile {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  } catch (error) {
    throw commandRefusal(`${path} could not be read: ${summarizeError(error)}. Nothing was changed.`, undefined, 'BUNDLE_UNREADABLE');
  }
  const candidate = value && typeof value === 'object' ? value as Partial<Record<keyof SubscriptionFile, unknown>> : {};
  const list = candidate.subscriptions;
  const subscriptions = Array.isArray(list) ? list.map(readFileSubscription) : [];
  if (candidate.version !== 1 || typeof candidate.exportedAt !== 'number' || !Number.isFinite(candidate.exportedAt) || !Array.isArray(list) || subscriptions.some((entry) => entry === null)) {
    throw commandRefusal(`${path} is not a sign-ins file (version 1, with exportedAt and a list of complete sign-ins). Nothing was changed.`, undefined, 'BUNDLE_UNREADABLE');
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

function precedence(record: Pick<ProviderSubscription, 'overrideAmbientApiKeys'>): string {
  return record.overrideAmbientApiKeys
    ? 'It is used before any API key you set for this provider.'
    : 'It is used for subscription routes only; an API key you set is used as before.';
}

function signedInLines(provider: string, record: ProviderSubscription): string {
  return [`Signed in to ${provider} with a subscription (${record.tokenType} token, ${record.expiresAt ? `expires ${iso(record.expiresAt)}` : 'no expiry'}).`, precedence(record)].join('\n');
}

function oauthConfigOf(ctx: ProviderCommandContext, provider: string) {
  const resolved = getSubscriptionProviderConfig(provider, host().requireServiceRegistry(ctx).get(provider));
  if (!resolved) {
    throw commandRefusal(
      `${provider} has no subscription sign-in.`,
      [
        `To add one, put an oauth block for it in ~/.goodvibes/${host().surfaceRoot}/services.json (your own services file; a project's file cannot carry one), for example:`,
        `  { "name": "${provider}", "authType": "oauth", "tokenKey": "${provider.toUpperCase()}_API_KEY", "providerId": "${provider}", "oauth": { "authUrl": "...", "tokenUrl": "...", "clientId": "...", "redirectUri": "http://127.0.0.1/callback", "scopes": ["..."] } }`,
      ].join('\n'),
      'OAUTH_NOT_CONFIGURED',
    );
  }
  return resolved;
}

/** The sign-in code path the daemon's providers.subscription.signIn.* methods share (config/subscription-sign-in.ts). */
function signInDeps(ctx: ProviderCommandContext): SubscriptionSignInDeps {
  const services = host().requireServiceRegistry(ctx);
  return { manager: host().requireSubscriptionManager(ctx), service: (provider) => services.get(provider) };
}

async function startSignIn(ctx: ProviderCommandContext, provider: string, openBrowser: boolean, waitForBrowser: boolean): Promise<string> {
  const manager = host().requireSubscriptionManager(ctx);
  oauthConfigOf(ctx, provider);
  // The browser can only come back here when it opens on this machine.
  const started = await beginSubscriptionSignIn(signInDeps(ctx), provider, host().signInListens && waitForBrowser && openBrowser);
  try {
    const opened = openBrowser ? await openExternalUrl(started.authorizationUrl) : false;
    const waits = started.completion !== null && opened;
    const finishLine = `/provider finish ${provider} <code or address>`;
    // The address is printed before any wait, so a browser that opened elsewhere
    // (another display, an SSH hop) never leaves the person without it.
    ctx.print([
      `Signing in to ${provider} (${host().formatSource(started.source)}).`,
      openBrowser ? (opened ? 'Your browser opened at:' : 'Your browser did not open; open this address:') : 'Open this address:',
      `  ${started.authorizationUrl}`,
      ...(started.listenerNote ? [started.listenerNote] : []),
      waits
        ? `Waiting for the browser to come back. If it opened somewhere else, finish with: ${finishLine}`
        : `When the page shows a code (or an address), finish with: ${finishLine}`,
    ].join('\n'));
    if (!waits || !started.completion) return '';
    try {
      return signedInLines(provider, await started.completion);
    } catch (error) {
      // A finish typed meanwhile already stored the sign-in.
      if (!manager.getPending(provider) && manager.get(provider)) return '';
      throw commandRefusal(`The sign-in to ${provider} did not finish on its own (${summarizeError(error)}); it is still waiting.`, `Finish with: ${finishLine}`, 'OAUTH_PENDING');
    }
  } finally {
    started.close();
  }
}

async function finishSignIn(ctx: ProviderCommandContext, provider: string, codeOrAddress: string): Promise<string> {
  oauthConfigOf(ctx, provider);
  try {
    return signedInLines(provider, await finishSubscriptionSignIn(signInDeps(ctx), provider, codeOrAddress));
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`The sign-in to ${provider} did not finish: ${summarizeError(error)}`, `Start again: /provider sign-in ${provider}`, 'NOT_DONE');
  }
}

async function showSignIn(ctx: ProviderCommandContext, provider: string): Promise<string> {
  const manager = host().requireSubscriptionManager(ctx);
  const services = host().requireServiceRegistry(ctx);
  const resolved = getSubscriptionProviderConfig(provider, services.get(provider));
  const stored = manager.get(provider);
  if (!resolved && !stored && !manager.getPending(provider)) {
    throw commandRefusal(`${provider} has no subscription sign-in, stored or available.`, '/provider list names the providers you can sign in to.', 'NOT_FOUND');
  }
  let inspection;
  try {
    inspection = await inspectProviderAuth(provider, { serviceRegistry: services, subscriptionManager: manager, secretsManager: host().requireSecretsManager(ctx) });
  } catch (error) {
    throw commandRefusal(`${provider}'s sign-in could not be read: ${summarizeError(error)}`, undefined, 'NOT_DONE');
  }
  return [
    `${provider} subscription sign-in`,
    `  can sign in: ${inspection.configured ? 'yes' : 'no'}`,
    `  state: ${stored ? 'signed in' : inspection.freshness === 'pending' ? 'waiting for its code' : 'not signed in'} (${inspection.freshness})`,
    ...(host().signInListens ? [`  finishes: ${inspection.callbackMode === 'local' ? 'on its own when the browser comes back' : 'with a pasted code'}`] : ['  finishes: with a pasted code']),
    ...(resolved ? [`  from: ${host().formatSource(resolved.source)}`, `  sign-in page: ${resolved.oauth.authUrl}`, `  returns to: ${resolved.oauth.redirectUri}`] : []),
    ...(stored ? [
      `  token: ${stored.tokenType}, ${stored.expiresAt ? `expires ${iso(stored.expiresAt)}` : 'no expiry'}, renewable: ${stored.refreshToken ? 'yes' : 'no'}`,
      `  signed in: ${iso(stored.createdAt)}, last updated ${iso(stored.updatedAt)}`,
      `  ${precedence(stored)}`,
    ] : []),
    ...inspection.issues.map((issue) => `  problem: ${issue}`),
    ...inspection.nextActions.map((step) => `  next: ${step}`),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Routing between providers
// ---------------------------------------------------------------------------

function optimizerOf(ctx: ProviderCommandContext): ProviderOptimizer {
  const optimizer = ctx.provider.providerOptimizer;
  if (!optimizer) throw commandRefusal('Routing between providers is not available in this session.');
  return optimizer;
}

const ROUTES: readonly FixedChoice[] = [
  { value: 'off', label: 'Only the model you chose', help: 'No failover: a request that fails stops and says why.' },
  { value: 'manual', label: 'Your model, moving on when a provider fails', help: 'A request that fails moves to the next provider that can serve it, and says so.' },
  { value: 'auto', label: 'The best provider for each request', help: 'Each request goes to the most capable provider for what it needs.' },
];

function routeWords(optimizer: ProviderOptimizer | undefined): string {
  if (!optimizer) return 'not available in this session';
  if (!optimizer.enabled) return 'only the model you chose, no failover';
  if (optimizer.pinnedTarget) return `every request to ${optimizer.pinnedTarget.providerId}/${optimizer.pinnedTarget.modelId}`;
  return optimizer.mode === 'auto' ? 'the best provider for each request' : 'your model, moving on when a provider fails';
}

function explanationLines(explanation: RouteExplanation): string[] {
  const lines = [`  ${explanation.accepted ? 'can serve' : 'cannot serve'}: ${explanation.providerId}/${explanation.modelId}`, `    ${explanation.summary}`];
  if (!explanation.accepted) {
    for (const rejection of explanation.rejections) lines.push(`    - ${rejection.reason} (has ${rejection.actual}, needs ${rejection.required})`);
    return lines;
  }
  const c = explanation.capability;
  const yes = (value: boolean) => (value ? 'yes' : 'no');
  lines.push(`    streaming ${yes(c.streaming)}, tools ${yes(c.toolCalling)}, parallel tools ${yes(c.parallelTools)}, JSON ${yes(c.jsonMode)}, reasoning ${yes(c.reasoningControls)}`);
  lines.push(`    context ${c.maxContextTokens.toLocaleString()} tokens, output ${c.maxOutputTokens.toLocaleString()} tokens, timeout ${c.timeoutMs} ms, caching ${c.caching}`);
  return lines;
}

function fallbackLogLines(optimizer: ProviderOptimizer): string[] {
  const log = optimizer.fallbackLog;
  if (log.length === 0) return ['No request has moved to another provider this session.'];
  const recent = log.slice(-5);
  return [`Recent moves (${recent.length} of ${log.length}):`, ...recent.map((move) => `  ${new Date(move.ts).toISOString().replace('T', ' ').slice(0, 19)}  ${move.from} to ${move.to} (${move.reason})`)];
}

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

const PROVIDER_INPUT: InputDescription = listInput({ id: 'provider', label: 'Provider', help: 'The providers you have', list: PROVIDERS });
const PATH = (help: string): InputDescription => textInput({ id: 'path', label: 'File', help, why: 'a file path on this machine', kind: 'path', typed: { position: 1 } });

export const PROVIDER_COMMAND: CommandDescription<ProviderCommandContext> = {
  name: 'provider',
  title: 'Providers',
  summary: 'Where your models come from: switch provider, add your own, sign in with a subscription, and choose how requests are routed',
  group: 'Models',
  report: 'see-providers',
  firstScreenRows: [
    'see-providers',
    'use',
    { label: 'Sign in with a subscription…', actions: ['sign-in', 'finish-sign-in', 'sign-out', 'see-sign-in', 'open-sign-ins'] },
    { label: 'Add or remove a provider of your own…', actions: ['add', 'remove'] },
    { label: 'Choose how requests are routed…', actions: ['route', 'pin-route', 'explain', 'test-fallback'] },
    { label: 'Move your sign-ins to another machine…', actions: ['save-sign-ins', 'check-sign-ins', 'load-sign-ins'] },
  ],
  actions: [
    readAction<ProviderCommandContext>({
      id: 'see-providers', label: 'See your providers', word: 'list',
      sentence: 'Shows the provider in use, every provider you have, your subscription sign-ins and how requests are routed.',
      operator: { method: 'models.list', fields: {} },
      async rowValue(ctx) { return ctx.session.runtime.provider || 'none chosen yet'; },
      async run(_values, ctx) {
        const api = host().requireProviderApi(ctx);
        const custom = new Set(customProviderNames(customDirectory(ctx)));
        const manager = host().requireSubscriptionManager(ctx);
        const available = listAvailableSubscriptionProviders(host().requireServiceRegistry(ctx).getAll());
        const ids = api.listProviderIds();
        return [
          `In use: ${ctx.session.runtime.provider || 'none'}${ctx.session.runtime.model ? ` (model ${ctx.session.runtime.model})` : ''}`,
          '',
          ids.length === 0 ? 'No providers yet: /provider add adds one of your own, /provider sign-in signs in with a subscription.' : 'Providers (/provider use <provider> switches):',
          ...ids.map((id) => {
            const stored = manager.get(id);
            const notes = [custom.has(id) ? 'your own' : '', stored ? `signed in with a subscription, ${stored.expiresAt ? `until ${iso(stored.expiresAt)}` : 'no expiry'}` : ''].filter(Boolean);
            return `  ${id === ctx.session.runtime.provider ? '▶' : ' '} ${id}${notes.length > 0 ? `  (${notes.join('; ')})` : ''}`;
          }),
          '',
          available.length === 0 ? 'No provider offers a subscription sign-in here.' : `You can sign in with a subscription to: ${available.map((entry) => entry.provider).join(', ')} (/provider sign-in <provider>).`,
          `Requests are routed: ${routeWords(ctx.provider.providerOptimizer)} (/provider route changes it).`,
        ].join('\n');
      },
    }),
    {
      id: 'use', label: 'Switch provider', word: 'use',
      inputs: [
        PROVIDER_INPUT,
        { ...listInput({ id: 'model', label: 'Model', help: 'One of its models', list: PROVIDER_MODELS, dependsOn: 'provider', optional: { default: '', means: 'its first model' } }), typed: { flag: '--model' } },
      ],
      sentence: 'Your conversations will use {provider} from the next message, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'In the web UI a switch is made by model.' },
      example: { provider: 'openai' },
      async run(values, ctx) {
        const api = host().requireProviderApi(ctx);
        const provider = values.provider!;
        const models = await api.listModels({ providerId: provider, selectableOnly: true });
        const first = models[0];
        if (!first) throw commandRefusal(`${provider} is not a provider with a model you can use; nothing was changed.`, `Providers: ${api.listProviderIds().join(', ')}`);
        let selected;
        try {
          selected = await api.selectModel(values.model ? formatProviderModel(provider, values.model) : first.registryKey);
        } catch (error) {
          throw commandRefusal(`Not switched: ${summarizeError(error)}.`, `/provider use ${provider} picks its first model.`, 'COMMAND_FAILED');
        }
        return new Promise<string>((resolve) => {
          host().beforeSelection(ctx, selected.providerId, () => {
            ctx.session.runtime.model = selected.registryKey;
            ctx.session.runtime.provider = selected.providerId;
            ctx.platform.configManager.set('provider.model', selected.registryKey);
            ctx.renderRequest?.();
            resolve(`Now using ${selected.providerId} (model ${selected.modelId}).`);
          });
        });
      },
    },
    {
      id: 'sign-in', label: 'Sign in with a subscription', word: 'sign-in',
      inputs: [
        listInput({ id: 'provider', label: 'Provider', help: 'The providers that offer a subscription sign-in', list: SUBSCRIPTION_PROVIDERS }),
        choiceInput({ id: 'browser', label: 'Browser', help: 'Open the sign-in page in your browser, or only show its address', choices: [
          { value: 'browser', label: 'Open my browser' },
          { value: 'print', label: 'Only show the address', help: 'For a browser on another machine' },
        ], typed: { flag: '--no-browser', switchOn: 'print' }, optional: { default: 'browser', means: 'open my browser' } }),
        choiceInput({ id: 'finish', label: 'How it finishes', help: 'On its own when the browser comes back to this machine, or by pasting the code the page shows', choices: [
          { value: 'wait', label: 'When the browser comes back', help: 'Needs the browser on this machine' },
          { value: 'paste', label: 'By pasting the code', help: 'Finish it with /provider finish' },
        ], typed: { flag: '--manual', switchOn: 'paste' }, optional: { default: 'wait', means: 'when the browser comes back' } }),
      ],
      sentence: 'A sign-in to {provider} starts in your browser; once it finishes, the sign-in is kept until you change it (signing out ends it).', done: '',
      touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'sign-out',
      operator: { terminalOnly: SIGN_IN_ALSO_WEB },
      example: { provider: 'openai' },
      async run(values, ctx) {
        return startSignIn(ctx, values.provider!, values.browser !== 'print', values.finish !== 'paste');
      },
    },
    {
      id: 'finish-sign-in', label: 'Finish signing in with a code', word: 'finish',
      inputs: [
        listInput({ id: 'provider', label: 'Provider', help: 'Sign-ins waiting for their code', list: PENDING }),
        { id: 'code', label: 'Code or address', help: 'The code the sign-in page showed, or the whole address it sent you to', kind: 'secret', required: true, typed: { position: 2 } },
      ],
      sentence: 'The sign-in to {provider} is finished with the code you give and kept until you change it (signing out ends it).', done: '',
      touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'sign-out',
      operator: { terminalOnly: SIGN_IN_ALSO_WEB },
      example: { provider: 'openai' },
      async run(values, ctx) {
        if (!values.code) throw commandRefusal('Not signed in: no code was given.');
        return finishSignIn(ctx, values.provider!, values.code);
      },
    },
    {
      id: 'sign-out', label: 'Sign out of a subscription', word: 'sign-out',
      inputs: [listInput({ id: 'provider', label: 'Provider', help: 'Your subscription sign-ins', list: STORED })],
      sentence: 'Your {provider} subscription sign-in is removed from this machine, and an API key you set for it is used again, until you change it.', done: '',
      touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'sign-in',
      operator: { terminalOnly: SIGN_IN_TERMINAL_ONLY },
      example: { provider: 'openai' },
      async run(values, ctx) {
        const removed = await host().requireSubscriptionManager(ctx).logout(values.provider!);
        if (!removed) throw commandRefusal(`There was no ${values.provider} subscription sign-in; nothing was changed.`, '/provider list shows your sign-ins.');
        return `Signed out of ${values.provider}. An API key you set for it is used again.`;
      },
    },
    readAction<ProviderCommandContext>({
      id: 'see-sign-in', label: 'See a subscription sign-in', word: 'show',
      inputs: [listInput({ id: 'provider', label: 'Provider', help: 'The providers that offer a subscription sign-in', list: SUBSCRIPTION_PROVIDERS })],
      sentence: 'Shows {provider}\'s subscription sign-in: whether you are signed in, until when, where it comes from and what to do next.',
      operator: { terminalOnly: SIGN_IN_TERMINAL_ONLY },
      example: { provider: 'openai' },
      async run(values, ctx) { return showSignIn(ctx, values.provider!); },
    }),
    readAction<ProviderCommandContext>({
      id: 'open-sign-ins', label: 'Open the sign-ins screen', word: 'open',
      sentence: 'Opens the screen that lists your subscription sign-ins with their state.',
      operator: { terminalOnly: 'It is a terminal screen.' },
      async run(_values, ctx) {
        if (!ctx.openModal) throw commandRefusal('This app has no sign-ins screen.', '/provider list shows your sign-ins, /provider show <provider> one of them.');
        ctx.openModal('subscription-modal');
      },
    }),
    {
      id: 'add', label: 'Add a provider of your own', word: 'add',
      inputs: [
        textInput({ id: 'name', label: 'Name', help: 'What it is called: letters, numbers, - and _', why: 'a name you choose', typed: { position: 1 } }),
        textInput({ id: 'address', label: 'Address', help: 'Where your server answers, such as http://127.0.0.1:8080/v1', why: 'the address of a server you run', typed: { position: 2 } }),
        { id: 'key', label: 'API key', help: 'Hidden as you type; leave it empty when the server needs none', kind: 'secret', required: { default: '', defaultMeans: 'no key' }, typed: { flag: '--key' } },
      ],
      sentence: '{name} is added with the models {address} lists, and a key you give is kept in your secret store, until you change it.', done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove',
      operator: { terminalOnly: 'Providers of your own are files of the terminal app that adds them.' },
      example: { name: 'my-server', address: 'http://192.168.0.85:8001/v1' },
      async run(values, ctx) {
        return addCustomProvider(
          { name: values.name!, address: values.address!, apiKey: values.key || undefined, directory: customDirectory(ctx), codeEditing: host().codeEditing },
          host().requireSecretsManager(ctx),
          (line) => ctx.print(line),
        );
      },
    },
    {
      id: 'remove', label: 'Remove a provider of your own', word: 'remove',
      inputs: [listInput({ id: 'name', label: 'Provider', help: 'The providers you added', list: CUSTOM })],
      sentence: '{name}\'s provider file and its stored key are deleted, and its models leave the list.', done: 'Removed {name}.',
      touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { terminalOnly: 'Providers of your own are files of the terminal app that added them.' },
      example: { name: 'my-server' },
      async run(values, ctx) { return removeCustomProvider(values.name!, customDirectory(ctx), host().requireSecretsManager(ctx)); },
    },
    {
      id: 'route', label: 'Choose how requests are routed', word: 'route',
      inputs: [choiceInput({ id: 'mode', label: 'Routing', help: 'Where a request goes, and what happens when a provider fails', choices: ROUTES, typed: { position: 1 } })],
      sentence: 'Requests are routed the way you chose ({mode}) from the next one, until you change it; a model every request was sent to is let go.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'Routing is applied by the terminal app\'s own provider stack.' },
      example: { mode: 'auto' },
      async run(values, ctx) {
        // provider.optimizerMode owns the routing; the provider stack applies the write to the live optimizer.
        ctx.platform.configManager.setDynamic('provider.optimizerMode', values.mode!);
        return `Requests are routed: ${routeWords(ctx.provider.providerOptimizer)}.`;
      },
    },
    {
      id: 'pin-route', label: 'Send every request to one model', word: 'pin-route',
      inputs: [listInput({ id: 'model', label: 'Model', help: 'The models you can use', list: MODELS_LIST })],
      sentence: 'Every request goes to {model} and no other provider is tried, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'route',
      operator: { terminalOnly: 'The routing target is checked against the models this terminal app has.' },
      example: { model: 'openai:gpt-5' },
      async run(values, ctx) {
        const models = await host().requireProviderApi(ctx).listModels();
        const match = models.find((model) => model.registryKey === values.model);
        if (!match) throw commandRefusal(`No model ${values.model} is known; the routing was not changed.`, '/model list shows the models you can use.');
        // The settings own the target; the provider stack applies them to the live optimizer.
        ctx.platform.configManager.setDynamic('provider.optimizerPinnedModel', `${match.providerId}:${match.modelId}`);
        ctx.platform.configManager.setDynamic('provider.optimizerMode', 'pinned');
        return `Every request goes to ${match.providerId}/${match.modelId}. /provider route lets it go.`;
      },
    },
    readAction<ProviderCommandContext>({
      id: 'explain', label: 'See why requests go where they go', word: 'explain',
      sentence: 'Shows whether the model in use can serve a request and why, how requests are routed, and the last moves to another provider.',
      operator: { terminalOnly: 'Routing is read from this terminal app\'s session.' },
      async run(_values, ctx) {
        const optimizer = optimizerOf(ctx);
        let current;
        try {
          current = await host().requireProviderApi(ctx).getCurrentModel();
        } catch {
          return 'No model is in use yet: /model use chooses one.';
        }
        return [
          `The model in use: ${current.providerId}/${current.modelId}`,
          ...explanationLines(optimizer.explainCurrentRoute()),
          `Requests are routed: ${routeWords(optimizer)}.`,
          ...fallbackLogLines(optimizer),
        ].join('\n');
      },
    }),
    readAction<ProviderCommandContext>({
      id: 'test-fallback', label: 'See where a failed request would go', word: 'fallback',
      sentence: 'Shows, without sending anything, which providers a failed request could move to and which could not serve it.',
      operator: { terminalOnly: 'Routing is read from this terminal app\'s session.' },
      async run(_values, ctx) {
        const optimizer = optimizerOf(ctx);
        const result = optimizer.testFallback();
        const capable = result.chain.filter((node) => node.capable);
        const rejected = result.chain.filter((node) => !node.capable);
        return [
          `${result.viableCount} of ${result.totalCount} providers could take a failed request (a request that needs nothing special):`,
          ...(capable.length === 0 ? ['  none'] : capable.slice(0, 10).map((node) => `  ${node.position}. ${node.providerId}/${node.modelId}`)),
          ...(capable.length > 10 ? [`  and ${capable.length - 10} more`] : []),
          ...(rejected.length > 0 ? [`Could not serve it (${rejected.length}):`, ...rejected.slice(0, 5).map((node) => `  ${node.providerId}/${node.modelId}: ${node.explanation.accepted ? 'unknown' : node.explanation.rejections.map((rejection) => rejection.reason).join('; ') || 'unknown'}`)] : []),
          ...(rejected.length > 5 ? [`  and ${rejected.length - 5} more`] : []),
          ...fallbackLogLines(optimizer),
        ].join('\n');
      },
    }),
    {
      id: 'save-sign-ins', label: 'Save your sign-ins to a file', word: 'export',
      inputs: [
        PATH('Where to write them, such as sign-ins.json'),
        choiceInput({
          id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', typed: { flag: '--replace', switchOn: 'yes' },
          choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone' }],
          optional: { default: 'no', means: 'keep it and stop' },
        }),
      ],
      sentence: 'Your subscription sign-ins, with their tokens, are written to {path} and stay there until you change it: anyone who reads the file can use them, so delete it once it has been used.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection',
      ownerOnly: { reason: 'it writes your sign-in tokens out of the secret store into a plain file', instead: 'Ask the owner to run /provider export <file>.' },
      operator: { terminalOnly: SIGN_IN_TERMINAL_ONLY },
      example: { path: 'sign-ins.json' },
      async run(values, ctx) {
        const target = host().requireShellPaths(ctx).resolveWorkspacePath(values.path!);
        const file: SubscriptionFile = { version: 1, exportedAt: Date.now(), subscriptions: host().requireSubscriptionManager(ctx).list().map(subscriptionExportForm) };
        const text = `${JSON.stringify(file, null, 2)}\n`;
        // Owner-only (0600): the file holds access and refresh tokens.
        if (values.replace === 'yes') {
          atomicWriteFileSync(target, text, { mkdirp: true });
        } else {
          // The check is the write itself: an existing file, even one made a moment ago, is never replaced.
          mkdirSync(dirname(target), { recursive: true });
          let fd: number;
          try {
            fd = openSync(target, 'wx', 0o600);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              throw commandRefusal(`${values.path} already exists; nothing was written.`, `Write over it: /provider export ${values.path} --replace`);
            }
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
        return `Wrote ${file.subscriptions.length} sign-in${file.subscriptions.length === 1 ? '' : 's'} to ${target}. The file holds working sign-in tokens: keep it private and delete it after use.`;
      },
    },
    readAction<ProviderCommandContext>({
      id: 'check-sign-ins', label: 'Check a sign-ins file', word: 'inspect',
      inputs: [PATH('A file written by /provider export')],
      sentence: 'Shows the sign-ins {path} holds and what loading it would add or replace, without changing anything.',
      operator: { terminalOnly: SIGN_IN_TERMINAL_ONLY },
      example: { path: 'sign-ins.json' },
      async run(values, ctx) {
        const target = host().requireShellPaths(ctx).resolveWorkspacePath(values.path!);
        const file = readSubscriptionFile(target);
        return [`${target}: ${file.subscriptions.length} sign-in${file.subscriptions.length === 1 ? '' : 's'}, written ${iso(file.exportedAt)}.`, 'Loading it would:', ...describeLoad(host().requireSubscriptionManager(ctx), file)].join('\n');
      },
    }),
    {
      id: 'load-sign-ins', label: 'Load sign-ins from a file', word: 'import',
      inputs: [PATH('A file written by /provider export')],
      sentence: 'The sign-ins in {path} are kept on this machine, each replacing any stored sign-in for the same provider.', done: '',
      touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
      operator: { terminalOnly: SIGN_IN_TERMINAL_ONLY },
      example: { path: 'sign-ins.json' },
      async run(values, ctx) {
        const target = host().requireShellPaths(ctx).resolveWorkspacePath(values.path!);
        const file = readSubscriptionFile(target);
        if (file.subscriptions.length === 0) throw commandRefusal(`${target} holds no sign-ins; nothing was changed.`, undefined, 'BUNDLE_EMPTY');
        const manager = host().requireSubscriptionManager(ctx);
        const lines = describeLoad(manager, file);
        for (const subscription of file.subscriptions) await manager.saveSubscription(subscription);
        return [`Loaded ${file.subscriptions.length} sign-in${file.subscriptions.length === 1 ? '' : 's'} from ${target}:`, ...lines].join('\n');
      },
    },
  ],
};

const PROVIDER_SLASH_COMMAND = defineCommand(PROVIDER_COMMAND);

/** Register `/provider` (the one description) with how this app reaches its services. */
export function registerProviderCommand<Ctx extends ProviderCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, services: ProviderCommandServices<Ctx>): void {
  installed = services as unknown as ProviderCommandServices<ProviderCommandContext>;
  registry.register(PROVIDER_SLASH_COMMAND);
}

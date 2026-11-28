/**
 * models-place.ts, the Models and providers place: the models every
 * conversation can use, the providers they come from and how you are signed in
 * to each, how requests are routed, the services your stored keys are sent to,
 * blind comparisons of models on one prompt, and moving sign-ins or the
 * services list to another machine; model servers on this computer are found
 * from anywhere in it.
 *
 * Everything listed is the daemon's, one copy for every program: the models,
 * providers, routing and the move list come from one read of `provider.list`,
 * the services from `services.list`, the media providers from
 * `media.providers`, the saved comparisons from `compare.review` (each named
 * by its prompt). The lists follow the daemon's provider changes, its
 * settings changes and the `models` and `services` list notices, so a pin, a
 * sign-in or a routing change made from the web UI, a script or the other
 * program shows here with no key pressed. Every action is a capability on the
 * item it acts on. The default model set here is the one a conversation uses
 * when it has not chosen its own (the model picker chooses for the
 * conversation it was opened in).
 */
import { definePlace, type PlaceItem } from './place-types.js';

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const time = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const list = (value: unknown): readonly Record<string, unknown>[] => Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object') : [];
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** Names a provider, a server or a services file chose, without control characters. */
const plain = (value: unknown): string => text(value).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').trim();
const when = (at: number | undefined): string => at ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'no end';
/** A capability's answer, as `capabilities.run` gives it: its `data`. */
const dataOf = (output: unknown): Record<string, unknown> => record(record(output).data);
const run = (id: string) => ({ id, inputs: {} });

interface ModelItem extends PlaceItem {
  readonly state: 'default' | 'default-pinned' | 'backup' | 'backup-pinned' | 'other' | 'other-pinned';
  readonly label: string;
  readonly provider: string;
  readonly contextWindow: number;
  /** Whether it reasons, from its own definition (what "why requests go there" says); undefined when not said. */
  readonly reasoning?: boolean | undefined;
  readonly backup: number;
  readonly pinned: boolean;
}

interface ProviderItem extends PlaceItem {
  readonly state: 'waiting' | 'signed-in' | 'expired' | 'expiring' | 'custom' | 'key-can-sign-in' | 'set-up' | 'can-sign-in' | 'not-set-up';
  readonly models: number;
  readonly inUse: boolean;
  readonly keyName: string;
  readonly route: string;
  readonly freshness: string;
  readonly issues: readonly string[];
  readonly notes: readonly string[];
  readonly expiresAt?: number | undefined;
}

interface RouteItem extends PlaceItem {
  readonly state: 'in-use' | 'other';
  readonly label: string;
  readonly help: string;
}

interface ServiceItem extends PlaceItem {
  readonly state: 'ready' | 'missing' | 'unreadable' | 'waiting';
  readonly authType: string;
  readonly address: string;
  readonly keyName: string;
  readonly missing: readonly string[];
  readonly sends: string;
  /** A project service waiting for you: the entry as this row shows it, which "use it" approves and nothing else. */
  readonly digest: string;
}

interface MoveItem extends PlaceItem {
  readonly state: 'sign-ins' | 'summary' | 'services';
  readonly label: string;
  readonly about: string;
}

interface MediaItem extends PlaceItem {
  /** `key-set` and `needs-key` are `ready` and `needs-setup` for a provider that takes a key: "store its key" shows there. */
  readonly state: 'ready' | 'needs-setup' | 'key-set' | 'needs-key';
  readonly label: string;
  readonly about: string;
  /** The name its key is stored under, for a provider that takes one (never the key). */
  readonly keyName?: string | undefined;
}

/** A saved comparison, by what it is: the answers, a judgment, a decision, a report, a handoff or its ZIP. */
interface ComparisonItem extends PlaceItem {
  readonly state: 'comparison' | 'judgment' | 'decision' | 'report' | 'handoff' | 'archive';
  /** The prompt of the comparison it belongs to. */
  readonly prompt: string;
  readonly createdAt: string;
  readonly winner: string;
  readonly winnerModel: string;
  readonly decision: string;
  readonly model: string;
}

type Item = ModelItem | ProviderItem | RouteItem | ServiceItem | MoveItem | MediaItem | ComparisonItem;

const COMPARISON_STATES: readonly ComparisonItem['state'][] = ['comparison', 'judgment', 'decision', 'report', 'handoff', 'archive'];

const COMPARISON_WORDS: Readonly<Record<ComparisonItem['state'], string>> = {
  comparison: 'answers to judge', judgment: 'judgment', decision: 'model decision', report: 'report', handoff: 'reviewer handoff', archive: 'handoff ZIP',
};

/** The saved comparisons as `compare.review` lists them (agent-turn/model-compare-person.ts). */
function comparisons(output: unknown): readonly ComparisonItem[] {
  return list(dataOf(output).saved).filter((saved) => text(saved.id) && COMPARISON_STATES.includes(text(saved.kind) as ComparisonItem['state'])).map((saved): ComparisonItem => ({
    id: text(saved.id),
    state: text(saved.kind) as ComparisonItem['state'],
    prompt: plain(saved.prompt),
    createdAt: text(saved.createdAt),
    winner: plain(saved.winner),
    winnerModel: plain(saved.winnerModel),
    decision: text(saved.decision),
    model: plain(saved.model),
  }));
}

function models(output: unknown): readonly ModelItem[] {
  return list(dataOf(output).models).filter((model) => text(model.registryKey)).map((model): ModelItem => {
    const role = model.isDefault === true ? 'default' : count(model.backup) > 0 ? 'backup' : 'other';
    const pinned = model.pinned === true;
    return {
      id: text(model.registryKey),
      state: (pinned ? `${role}-pinned` : role) as ModelItem['state'],
      label: plain(model.label) || text(model.registryKey),
      provider: plain(model.provider),
      contextWindow: count(model.contextWindow),
      ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
      backup: count(model.backup),
      pinned,
    };
  });
}

function providerState(provider: Record<string, unknown>): ProviderItem['state'] {
  const signIn = text(provider.signIn);
  if (signIn === 'waiting') return 'waiting';
  if (signIn === 'signed-in' || signIn === 'expired' || signIn === 'expiring') return signIn;
  if (provider.custom === true) return 'custom';
  if (provider.setUp === true) return signIn === 'can-sign-in' ? 'key-can-sign-in' : 'set-up';
  return signIn === 'can-sign-in' ? 'can-sign-in' : 'not-set-up';
}

function providers(output: unknown): readonly ProviderItem[] {
  return list(dataOf(output).providers).filter((provider) => text(provider.id)).map((provider): ProviderItem => ({
    id: text(provider.id),
    state: providerState(provider),
    models: count(provider.models),
    inUse: provider.inUse === true,
    keyName: text(provider.keyName),
    route: text(provider.route),
    freshness: text(provider.freshness),
    issues: strings(provider.issues).map(plain),
    notes: strings(provider.notes).map(plain),
    expiresAt: time(provider.expiresAt),
  }));
}

const ROUTE_CHOICES: readonly { readonly id: string; readonly label: string; readonly help: string }[] = [
  { id: 'off', label: 'Only the model you chose', help: 'No failover: a request that fails stops and says why.' },
  { id: 'manual', label: 'Your model, moving on when a provider fails', help: 'A request that fails moves to the next provider that can serve it, and says so.' },
  { id: 'auto', label: 'The best provider for each request', help: 'Each request goes to the most capable provider for what it needs.' },
];

function routes(output: unknown): readonly RouteItem[] {
  const data = dataOf(output);
  const inForce = text(data.routing);
  const pinned = text(data.pinnedRoute);
  return [
    ...ROUTE_CHOICES.map((choice): RouteItem => ({ id: choice.id, state: choice.id === inForce ? 'in-use' : 'other', label: choice.label, help: choice.help })),
    ...(inForce === 'pinned' && pinned ? [{ id: 'pinned', state: 'in-use' as const, label: `Every request to ${pinned}`, help: 'No other provider is tried. Choosing another way lets it go.' }] : []),
  ];
}

function services(output: unknown): readonly ServiceItem[] {
  const data = dataOf(output);
  const own = list(data.services).filter((service) => text(service.name)).map((service): ServiceItem => ({
    id: text(service.name),
    state: text(service.state) === 'ready' ? 'ready' : text(service.state) === 'unreadable' ? 'unreadable' : 'missing',
    authType: text(service.authType),
    address: plain(service.address),
    keyName: text(service.keyName),
    missing: strings(service.missing).map(plain),
    sends: '',
    digest: '',
  }));
  const waiting = list(data.pending).filter((service) => text(service.name)).map((service): ServiceItem => ({
    id: text(service.name), state: 'waiting', authType: '', address: '', keyName: '', missing: [], sends: plain(service.sends), digest: text(service.digest),
  }));
  return [...own, ...waiting];
}

function moves(output: unknown): readonly MoveItem[] {
  const data = dataOf(output);
  const stored = list(data.stored).length;
  return [
    { id: 'sign-ins', state: 'sign-ins', label: 'Your subscription sign-ins, with their tokens', about: `${stored} sign-in${stored === 1 ? '' : 's'} on this machine. A file of them lets another machine sign in as you: keep it private and delete it once used.` },
    { id: 'summary', state: 'summary', label: 'A summary of your sign-ins, with no token', about: 'The names of your stored secrets and providers, for a support thread. No secret or token is written.' },
    { id: 'services', state: 'services', label: 'Your services list', about: 'Each service\'s name, address and the name of the key it sends; never the keys.' },
  ];
}

function media(output: unknown): readonly MediaItem[] {
  return list(dataOf(output).providers).filter((provider) => text(provider.id)).map((provider): MediaItem => ({
    id: text(provider.id),
    state: provider.configured === true ? (text(provider.keyName) ? 'key-set' : 'ready') : (text(provider.keyName) ? 'needs-key' : 'needs-setup'),
    label: text(provider.id),
    about: plain(provider.state),
    ...(text(provider.keyName) ? { keyName: text(provider.keyName) } : {}),
  }));
}

/**
 * What the lists follow: the daemon's provider changes, its settings, and the models and services notices. A
 * declaration that names its notices hears only the events it names, so the two domains' frames (each carries its
 * domain's name) are named too; a program's own setting changed through the daemon is the `settings` notice.
 */
const FOLLOW = { domains: ['providers', 'config'], events: ['providers', 'config'], lists: ['models', 'services', 'settings'] } as const;

const SIGN_IN_WORDS: Readonly<Record<ProviderItem['state'], string>> = {
  waiting: 'waiting for its code',
  'signed-in': 'signed in with a subscription',
  expired: 'subscription sign-in ended',
  expiring: 'subscription sign-in ends soon',
  custom: 'your own server',
  'key-can-sign-in': 'set up; can also sign in with a subscription',
  'set-up': 'set up',
  'can-sign-in': 'can sign in with a subscription',
  'not-set-up': 'not set up',
};

/** How the daemon reaches a provider (its account record's `activeRoute`), in words. */
const ROUTE_WORDS: Readonly<Record<string, string>> = {
  'api-key': 'its API key',
  subscription: 'your subscription sign-in',
  'service-oauth': 'a service sign-in',
  unconfigured: 'nothing yet: no key and no sign-in',
};

/** How fresh its sign-in is (`authFreshness`), in words. */
const FRESHNESS_WORDS: Readonly<Record<string, string>> = {
  healthy: 'working',
  expiring: 'ends soon',
  expired: 'ended: sign in again',
  pending: 'waiting for its code',
  unconfigured: 'none',
};

/** The same, short enough for a row's right column, so the provider's name keeps its width. */
const SIGN_IN_SHORT: Readonly<Record<ProviderItem['state'], string>> = {
  waiting: 'needs its code',
  'signed-in': 'signed in',
  expired: 'sign-in ended',
  expiring: 'sign-in ends soon',
  custom: 'your own',
  'key-can-sign-in': 'set up',
  'set-up': 'set up',
  'can-sign-in': 'can sign in',
  'not-set-up': 'not set up',
};

const SUBSCRIPTION_STATES = ['waiting', 'signed-in', 'expired', 'expiring', 'key-can-sign-in', 'can-sign-in'] as const;
const USABLE_PROVIDER_STATES = ['signed-in', 'expiring', 'custom', 'key-can-sign-in', 'set-up'] as const;
const ALL_PROVIDER_STATES = ['waiting', 'signed-in', 'expired', 'expiring', 'custom', 'key-can-sign-in', 'set-up', 'can-sign-in', 'not-set-up'] as const;

export const MODELS_PLACE = definePlace<Item>({
  id: 'models',
  group: 'models',
  title: 'Models and providers',
  lists: [
    {
      id: 'models',
      label: 'Models',
      noun: 'the models you can use',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('provider.list'), items: models },
      follows: FOLLOW,
      empty: 'No models yet: no provider is set up. Add a provider of your own, or sign in on the Providers tab.',
      row: (item) => {
        const model = item as ModelItem;
        const role = model.state.startsWith('default') ? 'default' : model.backup > 0 ? `backup ${model.backup}` : '';
        const right = [role, model.pinned ? 'pinned' : ''].filter(Boolean).join(' · ');
        return {
          title: model.label,
          ...(right ? { right } : {}),
          ...(model.state.startsWith('default') ? { mark: 'ok' as const } : {}),
        };
      },
      detail: (item) => {
        const model = item as ModelItem;
        return [
          { label: 'Model', text: model.id },
          { label: 'Provider', text: model.provider || 'not said' },
          ...(model.contextWindow > 0 ? [{ label: 'Context', text: `${model.contextWindow.toLocaleString('en-US')} tokens` }] : []),
          ...(model.reasoning === undefined ? [] : [{ label: 'Reasoning', text: model.reasoning ? 'yes' : 'no' }]),
          { label: 'Default', text: model.state.startsWith('default') ? 'yes: every conversation that has not chosen its own model uses it' : 'no' },
          ...(model.backup > 0 ? [{ label: 'Backup', text: `tried ${model.backup === 1 ? 'first' : model.backup === 2 ? 'second' : `${model.backup}th`} when a turn fails on the default` }] : []),
          { label: 'Pinned', text: model.pinned ? 'yes: kept at the top of the model picker' : 'no' },
          { text: '' },
          { text: 'A conversation chooses its own model in its model picker; the default here is for the rest.', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'providers',
      label: 'Providers',
      noun: 'your providers',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('provider.list'), items: providers },
      follows: FOLLOW,
      empty: 'No provider yet: add one of your own, or a provider that offers a subscription sign-in will be listed here.',
      row: (item) => {
        const provider = item as ProviderItem;
        const attention = provider.state === 'expired' || provider.state === 'waiting' || provider.issues.length > 0;
        return {
          title: provider.id,
          right: provider.inUse ? `default · ${SIGN_IN_SHORT[provider.state]}` : SIGN_IN_SHORT[provider.state],
          mark: attention ? (provider.state === 'waiting' ? 'waiting' : 'attention') : provider.state === 'not-set-up' || provider.state === 'can-sign-in' ? 'paused' : 'ok',
        };
      },
      detail: (item) => {
        const provider = item as ProviderItem;
        return [
          { label: 'State', text: SIGN_IN_WORDS[provider.state] },
          ...(provider.expiresAt ? [{ label: 'Sign-in ends', text: when(provider.expiresAt) }] : []),
          { label: 'Models', text: String(provider.models) },
          ...(provider.route ? [{ label: 'Reached by', text: ROUTE_WORDS[provider.route] ?? provider.route }] : []),
          ...(provider.freshness ? [{ label: 'Sign-in', text: FRESHNESS_WORDS[provider.freshness] ?? provider.freshness }] : []),
          ...(provider.keyName ? [{ label: 'Its key', text: `${provider.keyName} (stored as a secret; never shown)` }] : []),
          ...(provider.inUse ? [{ label: 'Default', text: 'the default model is one of its models' }] : []),
          ...provider.issues.map((issue) => ({ label: 'Needs a look', text: issue, tone: 'warning' as const })),
          ...provider.notes.map((note) => ({ text: note, tone: 'muted' as const })),
        ];
      },
    },
    {
      id: 'routing',
      label: 'Routing',
      noun: 'how requests are routed',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('provider.list'), items: routes },
      follows: FOLLOW,
      empty: 'How requests are routed could not be told.',
      row: (item) => {
        const route = item as RouteItem;
        return { title: route.label, ...(route.state === 'in-use' ? { right: 'in use', mark: 'ok' as const } : {}) };
      },
      detail: (item) => {
        const route = item as RouteItem;
        return [
          { label: 'Routing', text: route.label },
          { text: route.help, tone: 'muted' as const },
          { label: 'In use', text: route.state === 'in-use' ? 'yes, for every program' : 'no' },
        ];
      },
    },
    {
      id: 'services',
      label: 'Services',
      noun: 'your services',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('services.list'), items: services },
      follows: FOLLOW,
      empty: 'No services yet: a services list can be loaded on the Move tab.',
      row: (item) => {
        const service = item as ServiceItem;
        return {
          title: service.id,
          right: service.state === 'waiting' ? 'from this project, waits for you' : service.state === 'ready' ? service.authType : service.state === 'unreadable' ? 'could not be read' : 'missing something',
          mark: service.state === 'ready' ? 'ok' : service.state === 'waiting' ? 'waiting' : 'attention',
        };
      },
      detail: (item) => {
        const service = item as ServiceItem;
        if (service.state === 'waiting') {
          return [
            { label: 'From', text: 'this project\'s services file' },
            { label: 'Would send', text: service.sends || 'not said' },
            { text: 'Whoever wrote the repository chose which of your stored keys it sends and where. Using it approves this entry as it reads now.', tone: 'warning' as const },
          ];
        }
        return [
          { label: 'Signs in with', text: service.authType || 'not said' },
          { label: 'Address', text: service.address || 'none' },
          ...(service.keyName ? [{ label: 'Key', text: `${service.keyName} (never shown)` }] : []),
          ...service.missing.map((missing) => ({ label: 'Needs a look', text: missing, tone: 'warning' as const })),
        ];
      },
    },
    {
      id: 'comparisons',
      label: 'Comparisons',
      noun: 'your model comparisons',
      // Saved comparisons are artifacts in the daemon's store; a new one, a judgment or a report announces `artifacts`.
      source: { kind: 'daemon', method: 'capabilities.run', input: run('compare.review'), items: comparisons },
      follows: { domains: [], events: [], lists: ['artifacts', 'models'] },
      empty: 'No model comparisons yet: c sends one prompt to two to four models with their names hidden, and keeps the answers here to judge.',
      row: (item) => {
        const saved = item as ComparisonItem;
        return { title: saved.prompt ? `"${saved.prompt}"` : 'A comparison', right: COMPARISON_WORDS[saved.state], mark: saved.state === 'comparison' ? 'waiting' : 'ok' };
      },
      detail: (item) => {
        const saved = item as ComparisonItem;
        return [
          { label: 'What it is', text: COMPARISON_WORDS[saved.state] },
          ...(saved.createdAt ? [{ label: 'Saved', text: when(Date.parse(saved.createdAt)) }] : []),
          ...(saved.winner ? [{ label: 'Won', text: `answer ${saved.winner}${saved.winnerModel ? `, by ${saved.winnerModel}` : ''}` }] : []),
          ...(saved.state === 'decision' ? [{ label: 'Decision', text: saved.decision === 'switched' ? `switched the default model to ${saved.model || 'the winner'}` : `kept ${saved.model || 'the default model'}` }] : []),
          { text: '' },
          {
            text: saved.state === 'comparison' ? 'Read the answers (v), then judge which won (j).'
              : saved.state === 'judgment' ? 'Switch to the winning model (a), or keep the default model and record why (k).'
                : 'Read it (v), or save a report or a reviewer handoff from it (e).',
            tone: 'muted' as const,
          },
        ];
      },
    },
    {
      id: 'media',
      label: 'Media',
      noun: 'the media providers',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('media.providers'), items: media },
      follows: FOLLOW,
      empty: 'No media providers are registered in this build.',
      row: (item) => {
        const provider = item as MediaItem;
        const set = provider.state === 'ready' || provider.state === 'key-set';
        return { title: provider.label, right: set ? 'set up' : 'setup needed', mark: set ? 'ok' : 'paused' };
      },
      detail: (item) => {
        const provider = item as MediaItem;
        const words: Readonly<Record<string, string>> = { unconfigured: 'not set up yet: it needs its key or address', configured: 'set up', ready: 'set up', available: 'set up', degraded: 'set up, but not answering as it should', unavailable: 'not reachable now' };
        return [
          { label: 'Provider', text: provider.label }, { label: 'State', text: words[provider.about] ?? (provider.about || (provider.state === 'ready' || provider.state === 'key-set' ? 'set up' : 'setup needed')) },
          ...(provider.keyName ? [{ label: 'Its key', text: `${provider.keyName} (stored as a secret; never shown)` }] : []),
        ];
      },
    },
    {
      id: 'move',
      label: 'Move',
      noun: 'what can be moved to another machine',
      source: { kind: 'daemon', method: 'capabilities.run', input: run('provider.list'), items: moves },
      follows: FOLLOW,
      empty: 'Nothing to move.',
      row: (item) => ({ title: (item as MoveItem).label }),
      detail: (item) => [{ text: (item as MoveItem).about }],
    },
  ],
  actions: [
    // Anywhere in the place.
    { key: 'n', capability: 'provider.add', label: 'add a provider of your own' },
    { key: 'g', capability: 'model.refresh', label: 'read the model lists again' },
    { key: 'm', capability: 'models.scan', label: 'find model servers on this computer' },
    // A model.
    { key: 'u', list: 'models', states: ['backup', 'backup-pinned', 'other', 'other-pinned'], capability: 'model.use', label: 'make it the default', fill: { model: 'id' } },
    { key: 'f', list: 'models', states: ['default', 'backup', 'other'], capability: 'pin.add', label: 'pin', fill: { model: 'id' } },
    { key: 'f', list: 'models', states: ['default-pinned', 'backup-pinned', 'other-pinned'], capability: 'pin.remove', label: 'unpin', fill: { model: 'id' } },
    { key: 'b', list: 'models', states: ['other', 'other-pinned'], capability: 'model.backup', label: 'add as a backup', fill: { model: 'id' } },
    { key: 'b', list: 'models', states: ['backup', 'backup-pinned'], capability: 'model.drop-backup', label: 'drop the backup', fill: { model: 'id' } },
    { key: 'o', list: 'models', capability: 'provider.pin-route', label: 'send every request here', fill: { model: 'id' } },
    // A provider.
    { key: 'u', list: 'providers', states: [...USABLE_PROVIDER_STATES], capability: 'provider.use', label: 'use its default model', fill: { provider: 'id' } },
    { key: 's', list: 'providers', states: ['key-can-sign-in', 'can-sign-in', 'expired', 'expiring'], capability: 'provider.sign-in', label: 'sign in', fill: { provider: 'id' } },
    { key: 'f', list: 'providers', states: ['waiting'], capability: 'provider.finish', label: 'finish signing in', fill: { provider: 'id' } },
    { key: 'o', list: 'providers', states: ['signed-in', 'expired', 'expiring'], capability: 'provider.sign-out', label: 'sign out', fill: { provider: 'id' } },
    { key: 'k', list: 'providers', states: ['set-up', 'key-can-sign-in', 'can-sign-in', 'not-set-up'], capability: 'secrets.set', label: 'store its key', fill: { key: (item) => (item as ProviderItem).keyName } },
    { key: 'x', list: 'providers', states: ['custom'], capability: 'provider.remove', label: 'remove', fill: { name: 'id' } },
    // A media provider that takes a key (a job it was still making is collected from the Work place once it has one).
    { key: 'k', id: 'store-media-key', list: 'media', states: ['needs-key', 'key-set'], capability: 'secrets.set', label: 'store its key', fill: { key: (item) => (item as MediaItem).keyName ?? '' } },
    { key: 'a', list: 'providers', states: [...ALL_PROVIDER_STATES], capability: 'accounts.show', label: 'its account', fill: { provider: 'id' } },
    { key: 'w', list: 'providers', states: [...ALL_PROVIDER_STATES], capability: 'accounts.routes', label: 'ways it is reached', fill: { provider: 'id' } },
    { key: 'h', list: 'providers', states: [...ALL_PROVIDER_STATES], capability: 'accounts.repair', label: 'how to fix it', fill: { provider: 'id' } },
    { key: 'v', list: 'providers', states: [...SUBSCRIPTION_STATES], capability: 'provider.show', label: 'its sign-in', fill: { provider: 'id' } },
    { key: 'j', list: 'providers', states: [...SUBSCRIPTION_STATES], capability: 'auth.show', label: 'sign-in settings', fill: { provider: 'id' } },
    { key: 'i', list: 'providers', states: [...SUBSCRIPTION_STATES], capability: 'auth.repair', label: 'fix the sign-in', fill: { provider: 'id' } },
    // How requests are routed.
    { key: 'enter', id: 'route', list: 'routing', states: ['other'], capability: 'provider.route', label: 'route this way', fill: { mode: 'id' } },
    { key: 'e', list: 'routing', capability: 'provider.explain', label: 'why requests go there' },
    { key: 't', list: 'routing', capability: 'provider.fallback', label: 'where a failed request goes' },
    // A service.
    { key: 't', list: 'services', states: ['ready', 'missing'], capability: 'services.test', label: 'test it', fill: { service: 'id' } },
    { key: 'c', list: 'services', states: ['ready', 'missing'], capability: 'services.check-auth', label: 'check its sign-in', fill: { service: 'id' } },
    { key: 'v', list: 'services', states: ['ready', 'missing', 'unreadable'], capability: 'services.show', label: 'what it holds', fill: { service: 'id' } },
    { key: 'y', list: 'services', states: ['waiting'], capability: 'services.trust', label: 'use it', fill: { service: 'id', shown: (item) => (item as ServiceItem).digest } },
    { key: 'a', list: 'services', capability: 'services.check', label: 'check every service' },
    // Model comparisons.
    { key: 'c', list: 'comparisons', whole: true, capability: 'compare.run', label: 'compare models on a prompt' },
    { key: 'b', list: 'comparisons', whole: true, capability: 'compare.benchmark', label: 'benchmark the local models' },
    { key: 'w', list: 'comparisons', whole: true, capability: 'compare.analytics', label: 'which models win' },
    { key: 'd', list: 'comparisons', whole: true, capability: 'compare.diff-handoffs', label: 'compare two handoffs' },
    { key: 'v', list: 'comparisons', capability: 'compare.review', label: 'read it', fill: { comparison: 'id' } },
    { key: 'j', list: 'comparisons', states: ['comparison'], capability: 'compare.judge', label: 'judge it', fill: { comparison: 'id' } },
    { key: 'a', list: 'comparisons', states: ['judgment'], capability: 'compare.apply', label: 'switch to the winner', fill: { judgment: 'id' } },
    { key: 'k', list: 'comparisons', states: ['judgment'], capability: 'compare.record-decision', label: 'keep the model, record why', fill: { judgment: 'id' } },
    { key: 'e', list: 'comparisons', states: ['comparison', 'judgment', 'handoff'], capability: 'compare.export', label: 'save a report or handoff', fill: { source: 'id' } },
    // Moving to another machine.
    { key: 'e', list: 'move', states: ['sign-ins'], capability: 'provider.export', label: 'save to a file' },
    { key: 'c', list: 'move', states: ['sign-ins'], capability: 'provider.inspect', label: 'check a file' },
    { key: 'l', list: 'move', states: ['sign-ins'], capability: 'provider.import', label: 'load from a file' },
    { key: 'e', list: 'move', states: ['summary'], capability: 'auth.export', label: 'save to a file' },
    { key: 'c', list: 'move', states: ['summary'], capability: 'auth.inspect', label: 'read a file' },
    { key: 'e', list: 'move', states: ['services'], capability: 'services.export', label: 'save to a file' },
    { key: 'l', list: 'move', states: ['services'], capability: 'services.import', label: 'replace from a file' },
  ],
  count: (lists) => {
    const wrong = (lists.providers ?? []).filter((item) => {
      const provider = item as ProviderItem;
      return provider.state === 'expired' || provider.issues.length > 0;
    }).length;
    const waiting = (lists.providers ?? []).filter((item) => (item as ProviderItem).state === 'waiting').length;
    if (wrong > 0) return { count: wrong, words: `${wrong} need${wrong === 1 ? 's' : ''} a look`, tone: 'wrong' };
    return waiting > 0 ? { count: waiting, words: `${waiting} sign-in${waiting === 1 ? '' : 's'} waiting`, tone: 'waiting' } : undefined;
  },
});

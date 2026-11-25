/**
 * `/model`, described once (command-actions/) for both terminal apps: which
 * model your conversations use, its backup models and the list of models read
 * again from every provider you have set up; and how hard the model thinks,
 * which is a control on the conversation (`effortOf`). Each app says how it
 * reaches its provider API and what it does before a switch lands (the
 * terminal app asks for a missing key first).
 */
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { LLMProvider, ProviderApi, ProviderApiLiveModelRefreshReport, ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import {
  describeEffortForModel,
  describeServingEffort,
  effortPresentationForModel,
  requestedEffortLevel,
  resolveRequestedEffortForServingModel,
  servingEffortForLevel,
  toEffortModel,
} from '@goodvibes/engine/platform/platform/providers/reasoning-effort-surface';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { DaemonVerbCaller } from '@goodvibes/engine/platform/platform/runtime/client';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, CommandDescription, InputDescription } from './command-actions/types.js';
import { doAction, listInput, readAction } from './described-command-kit.js';
import { daemonCapabilityAction, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import { MODEL_BACKUP, MODEL_DROP_BACKUP, type CapabilityDefinition } from '@goodvibes/engine/platform/platform/capabilities';

export interface ModelCommandContext extends CommandActionContext {
  readonly session: { readonly runtime: { model: string; provider: string; reasoningEffort: string } };
  readonly provider: { readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'listProviders'> };
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'set' | 'setRuntimeOverride'> };
  /** The full model picker (Recommended, price tier, a tab per job), where this surface has one. */
  readonly openModelPicker?: ((onClosed?: (chosen: boolean) => void) => void) | undefined;
}

/** How one app reaches its models, and what it does before a switch lands. */
export interface ModelCommandServices<Ctx extends ModelCommandContext> {
  readonly requireProviderApi: (ctx: Ctx) => ProviderApi;
  /** Runs `complete` once the provider is ready to use (the terminal app asks for a missing key first). It always runs `complete` exactly once. */
  readonly beforeSelection: (ctx: Ctx, providerId: string, complete: () => void) => void;
  /**
   * The daemon this app works with, asked to read its own lists again with
   * `/model refresh` (the lists the web UI and every other program show).
   */
  readonly daemon?: ((ctx: Ctx) => DaemonVerbCaller) | undefined;
  /** How this app runs a daemon capability (its `capability-binding.ts`): the backup models are the daemon's. */
  readonly binding?: DaemonCapabilityBinding<Ctx> | undefined;
}

/** The app's binding, read when an action runs (the description is built before the app registers it). */
const BINDING: DaemonCapabilityBinding<ModelCommandContext> = {
  daemon: (ctx) => {
    const binding = services().binding;
    if (!binding) throw commandRefusal('The daemon is not reachable from this program, so the backup models were not changed.');
    return binding.daemon(ctx);
  },
  caller: (ctx) => services().binding?.caller(ctx) ?? {},
};

/** One provider's line in `models.refresh`'s answer. */
interface DaemonRefreshReport {
  readonly providerId: string;
  readonly models: number;
  readonly source: string;
  readonly error?: string | undefined;
  readonly notAsked?: boolean | undefined;
}

/** Ask the daemon to read its model lists again; a line saying what it answered, or null when no daemon runs. */
async function refreshDaemonModelLists(ctx: ModelCommandContext): Promise<string | null> {
  const verbs = services().daemon?.(ctx);
  if (!verbs || !verbs.probe().available) return null;
  try {
    const answer = await verbs.invoke<{ readonly providers: readonly DaemonRefreshReport[] }>('models.refresh', {});
    const read = answer.providers.filter((report) => report.source === 'live').length;
    const failed = answer.providers.filter((report) => report.error !== undefined);
    return `The daemon read its lists again too (what the web UI and the other programs show): ${read} provider${read === 1 ? '' : 's'} answered`
      + `.${failed.length > 0 ? ` ${failed.map((report) => report.error).join(' ')}` : ''}`;
  } catch (error) {
    return `The daemon's lists were not read again: ${summarizeError(error)}.`;
  }
}

let installed: ModelCommandServices<ModelCommandContext> | undefined;
function services(): ModelCommandServices<ModelCommandContext> {
  if (!installed) throw commandRefusal('Models are not available in this session.');
  return installed;
}

// ---------------------------------------------------------------------------
// Live lists
// ---------------------------------------------------------------------------

const MODELS = defineList<ModelCommandContext>({
  name: 'models',
  async read(ctx) {
    const models = await services().requireProviderApi(ctx).listModels({ selectableOnly: true });
    return models.map((model): ListRow => ({
      value: model.registryKey,
      label: model.displayName,
      detail: model.providerId,
      ...(model.current ? { state: 'in use' } : {}),
    }));
  },
  operator: { method: 'models.list', input: {}, rows: { from: 'providers', each: 'models', value: 'registryKey', label: 'label', detail: 'provider' } },
});

/** The models you can switch to, as a live list (`/provider pin-route` chooses from it too). */
export const MODELS_LIST = MODELS;

function backupOrder(ctx: ModelCommandContext): string[] {
  const current = ctx.platform.configManager.get('provider.fallbackModels');
  return Array.isArray(current) ? current.filter((entry): entry is string => typeof entry === 'string') : [];
}

// The backups the daemon keeps (the setting every program reads from the daemon's settings), for model.drop-backup.
defineList<ModelCommandContext>({
  name: 'models.backups',
  async read(ctx) {
    return backupOrder(ctx).map((key, index): ListRow => ({ value: key, label: key, detail: `tried ${ordinal(index + 1)}` }));
  },
  operator: { terminalOnly: 'Backup models are kept in this terminal app\'s settings.' },
});

const EFFORT_LEVELS = defineList<ModelCommandContext>({
  name: 'effort.levels',
  async read(ctx) {
    const model = toEffortModel(ctx.provider.providerRegistry.getCurrentModel());
    const presentation = effortPresentationForModel(model);
    const inEffect = servingEffortForLevel(requestedEffortLevel(ctx.platform.configManager), model).effective;
    return presentation.choices.map((choice): ListRow => ({
      value: choice.level,
      label: choice.level,
      detail: choice.description,
      ...(choice.level === inEffect ? { state: 'in effect' } : {}),
    }));
  },
  operator: { terminalOnly: 'The levels belong to the model this terminal app uses.' },
});

function ordinal(n: number): string {
  return n === 1 ? 'first' : n === 2 ? 'second' : n === 3 ? 'third' : `${n}th`;
}

const MODEL: InputDescription = listInput({ id: 'model', label: 'Model', help: 'The models you can switch to', list: MODELS });

// ---------------------------------------------------------------------------
// Refreshing the list of models
// ---------------------------------------------------------------------------

/** A provider counts as set up when it has a credential or needs none. */
function isSetUp(provider: LLMProvider): boolean {
  const state = provider.describeAuthState?.();
  if (state) return state.configured || state.anonymousReady === true;
  return provider.isConfigured?.() ?? true;
}

/** One provider's line: how many models it has now, and why its list could not be read when it could not. */
function providerRefreshLine(name: string, count: number, report: ProviderApiLiveModelRefreshReport | undefined): string {
  const models = `${count} model${count === 1 ? '' : 's'}`;
  if (!report) return count === 0
    ? `  ${name}: no models: it does not list its own, and the built-in catalog has none for it`
    : `  ${name}: ${models} from the built-in catalog (it does not list its own models)`;
  if (report.skippedReason === 'local-endpoint-unavailable') {
    return `  ${name}: could not be read, its server is not running; ${count === 0 ? 'no models until it runs' : `${models} kept from its last list`}`;
  }
  if (report.error) {
    // The sentence says what failed and which list is shown.
    return `  ${name}: ${report.error} (${count === 0 ? 'no models' : models})`;
  }
  if (report.source === 'live') {
    const changes = [
      report.added.length > 0 ? `${report.added.length} new` : '',
      report.removed.length > 0 ? `${report.removed.length} retired` : '',
      report.unclassifiedModels?.length ? `${report.unclassifiedModels.length} without stated capabilities` : '',
    ].filter(Boolean);
    const found = count === 0 ? 'no models: it answered with an empty list' : `${models} found`;
    return `  ${name}: ${found}${changes.length > 0 ? ` (${changes.join(', ')})` : ''}${report.note ? `; ${report.note}` : ''}`;
  }
  // A list not read and no error: the provider was not asked, because it has nothing to sign in with yet.
  const from = report.source === 'cache' ? 'its last list' : 'the built-in catalog';
  return `  ${name}: not asked, it has no key or sign-in to list models with yet; ${count === 0 ? 'no models until it has one' : `${models} from ${from}`}`;
}

async function refreshModels(ctx: ModelCommandContext, api: ProviderApi): Promise<string> {
  ctx.print('Reading the list of models again from every provider you have set up…');
  const failed: string[] = [];
  const notes: string[] = [];
  let reports: readonly ProviderApiLiveModelRefreshReport[] = [];
  try {
    // An explicit refresh reads past each provider's cached list.
    reports = await api.refreshLiveModelDiscovery(undefined, { force: true });
  } catch (error) {
    failed.push('the providers\' own model lists');
    notes.push(`The providers' own model lists could not be read: ${summarizeError(error)}.`);
  }
  const step = async (what: string, run: () => Promise<string>) => {
    try { notes.push(await run()); } catch (error) { failed.push(what); notes.push(`The ${what} could not be refreshed: ${summarizeError(error)}.`); }
  };
  await step('model catalog', async () => { const catalog = await api.refreshCatalog(); return `Model catalog: ${catalog.modelCount} models from ${catalog.providerCount} providers.`; });
  await step('benchmarks', async () => { const count = await api.refreshBenchmarks(); return `Benchmarks: ${count > 0 ? `${count} model records` : 'refreshed'}.`; });
  await step('token limits', async () => `Token limits: ${await api.refreshModelLimits()} models updated.`);
  const daemonLine = await refreshDaemonModelLists(ctx);
  if (daemonLine !== null) notes.push(daemonLine);

  const all = await api.listModels();
  const byProvider = new Map(reports.map((report) => [report.providerId, report]));
  const setUp = ctx.provider.providerRegistry.listProviders().filter(isSetUp).map((provider) => provider.name).sort((a, b) => a.localeCompare(b));
  const lines = setUp.length === 0
    ? ['No provider is set up yet, so there is no list to read. Add one of your own or sign in with a subscription in Models and providers.']
    : [`Models by provider (${setUp.length} set up):`, ...setUp.map((name) => providerRefreshLine(name, all.filter((model) => model.providerId === name).length, byProvider.get(name)))];
  const text = [...lines, '', ...notes].join('\n');
  if (failed.length > 0) {
    ctx.print(text);
    throw commandRefusal(`Part of the refresh failed (${failed.join(', ')}); everything else above was refreshed.`, '/model refresh tries again.', 'PARTIALLY_DONE');
  }
  return text;
}

// ---------------------------------------------------------------------------
// The descriptions
// ---------------------------------------------------------------------------

function switchTo(ctx: ModelCommandContext, registryKey: string): Promise<string> {
  const api = services().requireProviderApi(ctx);
  return api.selectModel(registryKey).then((selected) => new Promise<string>((resolve) => {
    // The terminal app asks for a missing key first; the switch lands once the provider is ready.
    services().beforeSelection(ctx, selected.providerId, () => {
      ctx.session.runtime.model = selected.registryKey;
      ctx.session.runtime.provider = selected.providerId;
      // The shared default every program holds in the daemon's settings (config-ownership.ts), and this conversation's
      // own choice with it, so a model it chose before in its picker does not stay in force here.
      ctx.platform.configManager.set('provider.model', selected.registryKey);
      ctx.platform.configManager.setRuntimeOverride('provider.model', selected.registryKey);
      // The requested level may not exist on this model: the session runs at what it offers; the preference stays.
      const switchedTo = toEffortModel(ctx.provider.providerRegistry.getCurrentModel());
      const serving = resolveRequestedEffortForServingModel(ctx.platform.configManager, switchedTo);
      ctx.session.runtime.reasoningEffort = serving.effective ?? '';
      void api.recordModelUsage(selected.registryKey).catch((error: unknown) => logger.debug('model usage record failed', { error }));
      resolve([
        `Now using ${selected.displayName} (${selected.providerId}).`,
        ...(serving.requested !== '' ? [`Reasoning effort: ${describeServingEffort(serving, switchedTo)}.`] : []),
      ].join('\n'));
    });
  }), (error: unknown) => { throw commandRefusal(`Not switched: ${summarizeError(error)}.`, '/model list shows the models you can use.'); });
}

export const MODEL_COMMAND: CommandDescription<ModelCommandContext> = {
  name: 'model',
  title: 'Model',
  summary: 'Choose the model your conversations use and its backups, and read the list of models again',
  group: 'Models',
  report: 'see-models',
  // Bare `/model` opens the full picker; its other actions are typed lines.
  bareOpens: 'choose',
  firstScreenRows: ['choose', 'see-models', 'use', 'refresh', { label: 'Choose backup models…', actions: ['add-backup', 'remove-backup'] }],
  actions: [
    doAction<ModelCommandContext>({
      id: 'choose', label: 'Choose a model', word: 'choose',
      sentence: 'Opens the model picker: the Recommended short list first, each model with its price tier, and a tab for each job a model does.',
      operator: { terminalOnly: 'The model picker is this terminal program\'s screen; the web UI has its own model menu.' },
      async run(_values, ctx) {
        if (!ctx.openModelPicker) throw commandRefusal('The model picker is not available here.', '/model use <model> switches by name; /model list shows them.');
        ctx.openModelPicker();
      },
    }),
    readAction<ModelCommandContext>({
      id: 'see-models', label: 'See your model and the others you can use', word: 'list',
      sentence: 'Shows the model in use, its backup models, and every model you can switch to, by provider.',
      operator: { method: 'models.list', fields: {} },
      async rowValue(ctx) {
        const current = ctx.provider.providerRegistry.getCurrentModel();
        return current.displayName ?? current.id;
      },
      async run(_values, ctx) {
        const models = await services().requireProviderApi(ctx).listModels({ selectableOnly: true });
        const current = models.find((model) => model.current);
        const backups = backupOrder(ctx);
        return [
          current ? `In use: ${current.displayName} (${current.providerId}), ${current.registryKey}` : 'No model is in use yet. /model use chooses one.',
          backups.length === 0 ? 'No backup model: a turn that fails stops and says why.' : `Backup models, in order: ${backups.join(', ')}.`,
          '',
          models.length === 0 ? 'No model can be chosen yet: add a provider of your own or sign in with a subscription in Models and providers.' : 'Models you can switch to (/model use <model>):',
          ...models.map((model) => `  ${model.current ? '▶' : ' '} ${model.registryKey.padEnd(36)} ${model.displayName} (${model.providerId})`),
        ].join('\n');
      },
    }),
    {
      id: 'use', label: 'Switch model', word: 'use', inputs: [MODEL],
      sentence: 'Your conversations will use {model} from the next message, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { method: 'models.current.set', fields: { registryKey: 'model' } },
      example: { model: 'openai:gpt-5' },
      // `/model use` with no model named opens the full picker, as bare `/model` does.
      blankOpens: 'choose',
      async run(values, ctx) {
        const text = await switchTo(ctx, values.model!);
        ctx.renderRequest?.();
        return text;
      },
    },
    doAction<ModelCommandContext>({
      id: 'refresh', label: 'Read the list of models again', word: 'refresh', touches: 'another-machine',
      sentence: 'Asks every provider you have set up for its models again, here and on the daemon, and says for each how many it has or why its list could not be read.',
      operator: { method: 'models.refresh', fields: {} },
      async run(_values, ctx) {
        const text = await refreshModels(ctx, services().requireProviderApi(ctx));
        ctx.renderRequest?.();
        return text;
      },
    }),
    // The backups are the shared default's, kept by the daemon for every program (capabilities/builtin/models.ts).
    daemonCapabilityAction<ModelCommandContext>(MODEL_BACKUP as CapabilityDefinition<never>, BINDING),
    daemonCapabilityAction<ModelCommandContext>(MODEL_DROP_BACKUP as CapabilityDefinition<never>, BINDING),
  ],
};

/**
 * How hard this app's model thinks, as the conversation's controls take it (capabilities/builtin/conversation-controls.ts:
 * effort.show and effort.set, run from the conversation's list and by the model). The levels offered are the
 * model in use's (`effort.levels`, the list above).
 */
export function effortOf(ctx: ModelCommandContext): { effort(): Promise<string>; setEffort(level: string): Promise<string> } {
  return {
    async effort() {
      const model = toEffortModel(ctx.provider.providerRegistry.getCurrentModel());
      return describeEffortForModel(model, requestedEffortLevel(ctx.platform.configManager) || undefined).join('\n');
    },
    async setEffort(level) {
      const definition = ctx.provider.providerRegistry.getCurrentModel();
      const model = toEffortModel(definition);
      const presentation = effortPresentationForModel(model);
      if (!presentation.configurable) throw commandRefusal([presentation.headline, ...(presentation.caveat ? [presentation.caveat] : [])].join(' '));
      if (!presentation.choices.some((choice) => choice.level === level)) {
        throw commandRefusal(`${definition.displayName} does not offer reasoning effort '${level}'; nothing was changed.`, `Levels it offers: ${presentation.choices.map((choice) => choice.level).join(', ')}`);
      }
      // This conversation's own level: the shared default (the daemon's settings, Settings > reasoning effort) is not
      // touched, and the level lasts as long as this session.
      ctx.platform.configManager.setRuntimeOverride('provider.reasoningEffort', level);
      const serving = servingEffortForLevel(level, model);
      ctx.session.runtime.reasoningEffort = serving.effective ?? '';
      ctx.renderRequest?.();
      return `Reasoning effort: ${describeServingEffort(serving, model)}.`;
    },
  };
}

/** The effort levels list stays registered for the conversation's effort.set (`effort.levels`). */
export const EFFORT_LEVELS_LIST = EFFORT_LEVELS;

const MODEL_SLASH_COMMAND = defineCommand(MODEL_COMMAND);

/** Register `/model` (one description) with how this app reaches its models. */
export function registerModelCommands<Ctx extends ModelCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: ModelCommandServices<Ctx>): void {
  installed = host as unknown as ModelCommandServices<ModelCommandContext>;
  registry.register(MODEL_SLASH_COMMAND);
}

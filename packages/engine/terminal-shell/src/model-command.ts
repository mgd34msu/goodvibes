/**
 * `/model` and `/effort`, each described once (command-actions/) for both
 * terminal apps: which model your conversations use, its backup models, the
 * list of models read again from every provider you have set up, and how hard
 * the model thinks. Each app says how it reaches its provider API and what it
 * does before a switch lands (the terminal app asks for a missing key first).
 */
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { LLMProvider, ProviderApi, ProviderApiLiveModelRefreshReport, ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import {
  describeEffortForModel,
  describeServingEffort,
  effortPresentationForModel,
  requestedEffortLevel,
  resolveRequestedEffortForServingModel,
  servingEffortForLevel,
  toEffortModel,
} from '@goodvibes-jev/engine/platform/platform/providers/reasoning-effort-surface';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, CommandDescription, InputDescription } from './command-actions/types.js';
import { doAction, listInput, readAction } from './described-command-kit.js';

export interface ModelCommandContext extends CommandActionContext {
  readonly session: { readonly runtime: { model: string; provider: string; reasoningEffort: string } };
  readonly provider: { readonly providerRegistry: Pick<ProviderRegistry, 'getCurrentModel' | 'listProviders'> };
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'set'> };
}

/** How one app reaches its models, and what it does before a switch lands. */
export interface ModelCommandServices<Ctx extends ModelCommandContext> {
  readonly requireProviderApi: (ctx: Ctx) => ProviderApi;
  /** Runs `complete` once the provider is ready to use (the terminal app asks for a missing key first). It always runs `complete` exactly once. */
  readonly beforeSelection: (ctx: Ctx, providerId: string, complete: () => void) => void;
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

const BACKUPS = defineList<ModelCommandContext>({
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
    const from = report.source === 'cache' ? 'its last list' : 'the built-in catalog';
    return `  ${name}: could not be read (${report.error}); ${count === 0 ? 'no models' : `${models} from ${from}`}`;
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

  const all = await api.listModels();
  const byProvider = new Map(reports.map((report) => [report.providerId, report]));
  const setUp = ctx.provider.providerRegistry.listProviders().filter(isSetUp).map((provider) => provider.name).sort((a, b) => a.localeCompare(b));
  const lines = setUp.length === 0
    ? ['No provider is set up yet, so there is no list to read. /provider adds one or signs in with a subscription.']
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
      ctx.platform.configManager.set('provider.model', selected.registryKey);
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
  firstScreenRows: ['see-models', 'use', 'refresh', { label: 'Choose backup models…', actions: ['add-backup', 'remove-backup'] }],
  actions: [
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
          models.length === 0 ? 'No model can be chosen yet: /provider adds a provider or signs in with a subscription.' : 'Models you can switch to (/model use <model>):',
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
      async run(values, ctx) {
        const text = await switchTo(ctx, values.model!);
        ctx.renderRequest?.();
        return text;
      },
    },
    doAction<ModelCommandContext>({
      id: 'refresh', label: 'Read the list of models again', word: 'refresh', touches: 'another-machine',
      sentence: 'Asks every provider you have set up for its models again, and says for each how many it has or why its list could not be read.',
      operator: { terminalOnly: 'It refreshes the lists this terminal app reads its models from.' },
      async run(_values, ctx) {
        const text = await refreshModels(ctx, services().requireProviderApi(ctx));
        ctx.renderRequest?.();
        return text;
      },
    }),
    {
      id: 'add-backup', label: 'Add a backup model', word: 'backup', inputs: [{ ...MODEL, help: 'The model a turn moves to when yours fails' }],
      sentence: 'When a turn fails on your model, it moves to {model} (after any backups already listed), until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove-backup',
      operator: { terminalOnly: 'Backup models are kept in this terminal app\'s settings.' },
      example: { model: 'openai:gpt-5-mini' },
      async run(values, ctx) {
        const models = await services().requireProviderApi(ctx).listModels({ selectableOnly: true });
        const match = models.find((model) => model.registryKey === values.model || model.modelId === values.model);
        if (!match) throw commandRefusal(`No model you can use is named ${values.model}; the backups were not changed.`, '/model list shows them.');
        const order = backupOrder(ctx);
        if (order.includes(match.registryKey)) return `${match.registryKey} is already a backup. Backup models, in order: ${order.join(', ')}.`;
        const next = [...order, match.registryKey];
        ctx.platform.configManager.set('provider.fallbackModels', next);
        return `Backup models, in order: ${next.join(', ')}.`;
      },
    },
    {
      id: 'remove-backup', label: 'Remove a backup model', word: 'drop-backup',
      inputs: [listInput({ id: 'model', label: 'Backup model', help: 'Your backup models', list: BACKUPS })],
      sentence: 'A turn that fails will no longer move to {model}, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'add-backup',
      operator: { terminalOnly: 'Backup models are kept in this terminal app\'s settings.' },
      example: { model: 'openai:gpt-5-mini' },
      async run(values, ctx) {
        const order = backupOrder(ctx);
        if (!order.includes(values.model!)) throw commandRefusal(`${values.model} is not a backup model; nothing was changed.`, '/model list shows the backups.');
        const next = order.filter((key) => key !== values.model);
        ctx.platform.configManager.set('provider.fallbackModels', next);
        return next.length === 0 ? 'No backup model is left: a turn that fails stops and says why.' : `Backup models, in order: ${next.join(', ')}.`;
      },
    },
  ],
};

export const EFFORT_COMMAND: CommandDescription<ModelCommandContext> = {
  name: 'effort',
  title: 'Reasoning effort',
  summary: 'How hard the model thinks before it answers',
  group: 'Models',
  report: 'see-effort',
  actions: [
    readAction<ModelCommandContext>({
      id: 'see-effort', label: 'See how hard the model thinks', word: 'show',
      sentence: 'Shows the level you chose, the level the model in use runs at, and the levels it offers.',
      operator: { terminalOnly: 'The levels belong to the model this terminal app uses.' },
      async rowValue(ctx) {
        return requestedEffortLevel(ctx.platform.configManager) || 'the model\'s usual';
      },
      async run(_values, ctx) {
        const model = toEffortModel(ctx.provider.providerRegistry.getCurrentModel());
        return describeEffortForModel(model, requestedEffortLevel(ctx.platform.configManager) || undefined).join('\n');
      },
    }),
    {
      id: 'set', label: 'Choose how hard the model thinks', word: 'set',
      inputs: [listInput({ id: 'level', label: 'Level', help: 'The levels the model in use offers', list: EFFORT_LEVELS })],
      sentence: 'The model will think at {level} from the next message, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      operator: { terminalOnly: 'The levels belong to the model this terminal app uses.' },
      example: { level: 'high' },
      async run(values, ctx) {
        const definition = ctx.provider.providerRegistry.getCurrentModel();
        const model = toEffortModel(definition);
        const presentation = effortPresentationForModel(model);
        if (!presentation.configurable) throw commandRefusal([presentation.headline, ...(presentation.caveat ? [presentation.caveat] : [])].join(' '));
        const level = values.level!;
        if (!presentation.choices.some((choice) => choice.level === level)) {
          throw commandRefusal(`${definition.displayName} does not offer reasoning effort '${level}'; nothing was changed.`, `Levels it offers: ${presentation.choices.map((choice) => choice.level).join(', ')}`);
        }
        // An explicit choice is the one write allowed to change the stored preference.
        ctx.platform.configManager.set('provider.reasoningEffort', level);
        const serving = servingEffortForLevel(level, model);
        ctx.session.runtime.reasoningEffort = serving.effective ?? '';
        ctx.renderRequest?.();
        return `Reasoning effort: ${describeServingEffort(serving, model)}.`;
      },
    },
  ],
};

const MODEL_SLASH_COMMAND = defineCommand(MODEL_COMMAND);
const EFFORT_SLASH_COMMAND = defineCommand(EFFORT_COMMAND);

/** Register `/model` and `/effort` (one description each) with how this app reaches its models. */
export function registerModelCommands<Ctx extends ModelCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: ModelCommandServices<Ctx>): void {
  installed = host as unknown as ModelCommandServices<ModelCommandContext>;
  registry.register(MODEL_SLASH_COMMAND);
  registry.register(EFFORT_SLASH_COMMAND);
}

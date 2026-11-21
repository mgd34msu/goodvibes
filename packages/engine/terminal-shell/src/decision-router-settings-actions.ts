import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureDecisionRouterSettings, type ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { ModelDefinition } from '@goodvibes/engine/platform/platform/providers';
import { effortLevelsForModel } from '@goodvibes/engine/platform/platform/providers/reasoning-effort-surface';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { OpenSelection } from './selection-modal.js';
import type { FileEditorOpener } from './external-editor.js';

export interface DecisionRouterPickerContext {
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic'> };
  readonly provider: { readonly providerRegistry: { listModels(): ModelDefinition[] } };
  readonly openSelection?: OpenSelection | undefined;
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
  /** Runs $VISUAL / $EDITOR on a file and resolves when it exits; where present, the advanced settings are edited there. */
  readonly openFileInEditor?: FileEditorOpener | undefined;
}

/** Why a typed routing configuration is refused, or undefined when it is valid. */
function routingProblem(text: string): string | undefined {
  try {
    captureDecisionRouterSettings(JSON.parse(text));
    return undefined;
  } catch (error) {
    return summarizeError(error);
  }
}

function editorConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return Boolean((env.VISUAL || env.EDITOR || '').trim());
}

/** Configure answer routes without changing the active conversation provider. */
export function openDecisionRouterSettings(ctx: DecisionRouterPickerContext, changed: () => void = ctx.renderRequest): boolean {
  const open = ctx.openSelection;
  if (!open) return false;
  const config = ctx.platform.configManager;
  let settings: ReturnType<typeof captureDecisionRouterSettings>;
  try { settings = captureDecisionRouterSettings(config.get('provider.decisionRouter')); }
  catch (error) { ctx.print('Unable to read routing settings: ' + summarizeError(error)); return true; }
  const openedRevision = JSON.stringify(settings);
  const readRevision = (): string => JSON.stringify(captureDecisionRouterSettings(config.get('provider.decisionRouter')));
  /** Whether the saved settings are still the ones `baseline` recorded. */
  const unchangedSince = (baseline: string): boolean => readRevision() === baseline;
  const current = () => {
    if (unchangedSince(openedRevision)) return true;
    ctx.print('Routing settings changed while this picker was open. Reopen it before saving.');
    changed(); ctx.renderRequest(); return false;
  };
  const save = (id: string, model: ModelDefinition | null, effort?: string) => {
    try {
      if (!current()) return;
      const latest = captureDecisionRouterSettings(config.get('provider.decisionRouter'));
      const category = latest.categories[id];
      if (!category) throw new Error('Routing category changed; reopen its settings.');
      config.setDynamic('provider.decisionRouter', {
        ...latest,
        categories: { ...latest.categories, [id]: { ...category, target: model
          ? { provider: model.provider, model: model.id, ...(effort ? { effort } : {}) } : null } },
      });
      changed(); ctx.renderRequest();
    } catch (error) { ctx.print('Unable to save routing settings: ' + summarizeError(error)); ctx.renderRequest(); }
  };
  open('Decision Router — choose a category', Object.entries(settings.categories).map(([id, category]) => ({
    id, label: category.label,
    detail: category.target ? `${category.target.provider}:${category.target.model}${category.target.effort ? ` · ${category.target.effort}` : ''}`
      : id === 'general' ? 'Choose the required catch-all model.' : 'Uses General.',
    primaryAction: 'select' as const,
  })).concat([{ id: '__advanced__', label: 'Advanced categories / context limits', detail: 'Edit all routing settings as validated JSON.', primaryAction: 'select' }]), { allowSearch: true }, selected => {
    if (!selected) return;
    const id = selected.item.id;
    if (id === '__advanced__') {
      const apply: ApplyRouting = (text, baseline) => {
        try {
          if (!unchangedSince(baseline)) return 'overtaken';
          config.setDynamic('provider.decisionRouter', captureDecisionRouterSettings(JSON.parse(text))); changed(); ctx.renderRequest();
          return 'saved';
        } catch (error) { ctx.print('Unable to save routing settings: ' + summarizeError(error)); ctx.renderRequest(); return 'failed'; }
      };
      if (ctx.openFileInEditor && editorConfigured()) {
        // The editor's own baseline is taken as its file is written, not when the picker opened.
        void editAdvancedInEditor(ctx, ctx.openFileInEditor, JSON.stringify(config.get('provider.decisionRouter'), null, 2), readRevision, apply, changed);
        return;
      }
      // No external editor: the whole configuration is typed on one line, and a refused value says why as it is typed.
      const currentJson = JSON.stringify(config.get('provider.decisionRouter'));
      open('Advanced Decision Router — JSON (set $EDITOR to edit it in your editor)', [{ id: currentJson, label: currentJson }], {
        allowSearch: true, customItem: query => {
          const problem = routingProblem(query);
          return problem === undefined
            ? { id: query, label: 'Use routing configuration', detail: query }
            : { id: INVALID_ROUTING, label: 'Not valid routing settings', detail: problem };
        },
      }, result => {
        if (!result) return;
        if (result.item.id === INVALID_ROUTING) { ctx.print('Routing settings not saved: ' + (result.item.detail ?? 'not valid JSON')); ctx.renderRequest(); return; }
        if (apply(result.item.id, openedRevision) === 'overtaken') {
          ctx.print('Routing settings changed while this picker was open. Reopen it before saving.');
          changed(); ctx.renderRequest();
        }
      });
      return;
    }
    const models = ctx.provider.providerRegistry.listModels().filter(model => model.provider !== 'decision-router' && model.selectable !== false);
    const providers = [...new Set(models.map(model => model.provider))];
    const selectProvider = () => open('Answer provider', [
      ...(id !== 'general' ? [{ id: '__general__', label: 'Use General', detail: 'Remove this category override.', primaryAction: 'select' as const }] : []),
      ...providers.map(provider => ({ id: provider, label: provider, primaryAction: 'select' as const })),
    ], { allowSearch: true }, provider => {
      if (!provider) return;
      if (provider.item.id === '__general__') { save(id, null); return; }
      const candidates = models.filter(model => model.provider === provider.item.id);
      open('Answer model', candidates.map(model => ({ id: model.registryKey, label: model.displayName, detail: model.id, primaryAction: 'select' })),
        { allowSearch: true }, picked => {
          const model = candidates.find(candidate => candidate.registryKey === picked?.item.id);
          if (!model) return;
          const levels = effortLevelsForModel(model);
          if (levels.length === 0) { save(id, model); return; }
          open('Answer reasoning effort', [
            { id: '', label: 'Model default', primaryAction: 'select' },
            ...levels.map(level => ({ id: level, label: level, primaryAction: 'select' as const })),
          ], { allowSearch: false }, effort => { if (effort) save(id, model, effort.item.id || undefined); });
        });
    });
    selectProvider();
  });
  return true;
}

const INVALID_ROUTING = '__invalid_routing__';

/** Saves typed routing settings unless the saved ones changed since `baseline`; says which happened. */
type ApplyRouting = (text: string, baseline: string) => 'saved' | 'overtaken' | 'failed';

/**
 * Edit the routing settings as pretty JSON in the user's editor. The file is
 * read back only after the editor exits, and removed after that. A refused
 * edit, or one overtaken by a change made elsewhere while the editor was open,
 * offers to edit it again, starting from what was typed, so nothing written is
 * lost to a typo or to another surface's save.
 */
async function editAdvancedInEditor(
  ctx: DecisionRouterPickerContext,
  openFileInEditor: FileEditorOpener,
  initial: string,
  readRevision: () => string,
  apply: ApplyRouting,
  changed: () => void,
): Promise<void> {
  let dir: string | undefined;
  let edited = initial;
  let baseline = '';
  try {
    baseline = readRevision();
    dir = mkdtempSync(join(tmpdir(), 'goodvibes-routing-'));
    const file = join(dir, 'decision-router.json');
    writeFileSync(file, `${initial}\n`, { encoding: 'utf8', mode: 0o600 });
    if (!(await openFileInEditor(file))) {
      // The opener has already said why the editor did not finish.
      ctx.print('Routing settings not saved: the editor did not exit cleanly. The saved settings stay as they were.');
      ctx.renderRequest();
      return;
    }
    edited = readFileSync(file, 'utf8').trim();
  } catch (error) {
    ctx.print('Unable to edit routing settings: ' + summarizeError(error));
    ctx.renderRequest();
    return;
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
  const problem = routingProblem(edited);
  if (problem === undefined && sameSettings(edited, baseline)) { ctx.print('Routing settings unchanged.'); ctx.renderRequest(); return; }
  let reason: string;
  if (problem === undefined) {
    const outcome = apply(edited, baseline);
    if (outcome !== 'overtaken') return;
    reason = 'The routing settings were changed elsewhere while the editor was open, so this edit was not saved over them.';
    changed(); ctx.renderRequest();
  } else {
    reason = problem;
  }
  const open = ctx.openSelection;
  if (!open) { ctx.print('Routing settings not saved: ' + reason); ctx.renderRequest(); return; }
  open('Routing settings not saved', [
    { id: 'edit', label: 'Edit again', detail: reason, primaryAction: 'select' },
    { id: 'discard', label: 'Discard the edit', detail: 'The saved routing settings stay as they are.', primaryAction: 'select' },
  ], { allowSearch: false }, choice => {
    // Edit again reopens the kept text against the settings as they are now.
    if (choice?.item.id === 'edit') void editAdvancedInEditor(ctx, openFileInEditor, edited, readRevision, apply, changed);
    else ctx.print('Routing settings not saved: ' + reason);
  });
}

/** Whether typed routing settings are the ones `revision` recorded. */
function sameSettings(text: string, revision: string): boolean {
  try { return JSON.stringify(captureDecisionRouterSettings(JSON.parse(text))) === revision; }
  catch { return false; }
}

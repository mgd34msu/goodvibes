import { captureDecisionRouterSettings, type ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import { effortLevelsForModel } from '@goodvibes-jev/engine/platform/platform/providers/reasoning-effort-surface';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { OpenSelection } from './selection-modal.js';

export interface DecisionRouterPickerContext {
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic'> };
  readonly provider: { readonly providerRegistry: { listModels(): ModelDefinition[] } };
  readonly openSelection?: OpenSelection | undefined;
  readonly print: (message: string) => void;
  readonly renderRequest: () => void;
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
  const current = () => {
    if (JSON.stringify(captureDecisionRouterSettings(config.get('provider.decisionRouter'))) === openedRevision) return true;
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
      const currentJson = JSON.stringify(config.get('provider.decisionRouter'));
      open('Advanced Decision Router — JSON', [{ id: currentJson, label: currentJson }], {
        allowSearch: true, customItem: query => {
          try { captureDecisionRouterSettings(JSON.parse(query)); return { id: query, label: 'Use routing configuration', detail: query }; }
          catch { return null; }
        },
      }, result => {
        if (!result) return;
        try { if (!current()) return; config.setDynamic('provider.decisionRouter', captureDecisionRouterSettings(JSON.parse(result.item.id))); changed(); ctx.renderRequest(); }
        catch (error) { ctx.print('Unable to save routing settings: ' + summarizeError(error)); }
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

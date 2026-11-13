import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import {
  offersConfigurableEffort,
  requestedEffortLevel,
  servingEffortForLevel,
  toEffortModel,
  type RequestedEffortReader,
} from '@goodvibes-jev/engine/platform/platform/providers/reasoning-effort-surface';
import type { ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import type { ModelPickerModal } from './model-picker.js';
import type { CapabilityFilter, CategoryFilter } from './model-picker-types.js';
import { isTextBackspace } from './delete-key-policy.js';
export interface ModelPickerCommandContext {
  readonly provider: {
    readonly providerRegistry: Pick<import('@goodvibes-jev/engine/platform/platform/providers').ProviderRegistry, 'getSelectableModels'>;
  };
  readonly platform?:
    | {
        readonly configManager?: RequestedEffortReader | undefined;
      }
    | undefined;
  readonly executeCommand?: ((name: string, args: string[]) => Promise<boolean>) | undefined;
}
export interface ModelPickerTokenState<Context, Picker extends ModelPickerModal> {
  modelPicker: Picker;
  modalStack: string[];
  commandContext?: Context | undefined;
  getViewportHeight: () => number;
  requestRender: () => void;
  handleEscape: () => void;
  onModelPickerCommit?: (() => boolean) | undefined;
}
export interface PickerSelection<Picker extends ModelPickerModal> {
  readonly model: ModelDefinition;
  readonly effort: string;
  readonly target: Picker['target'];
  readonly contextCap?: number | null | undefined;
  readonly effortChosenByUser?: boolean | undefined;
}
export function closeModelPickerRoute(state: {
  readonly modelPicker: {
    close(): void;
  };
  readonly modalStack: string[];
}): void {
  state.modelPicker.close();
  if (state.modalStack[state.modalStack.length - 1] === 'modelPicker') state.modalStack.pop();
}
export function createModelPickerTokenHandler<Context extends ModelPickerCommandContext, Picker extends ModelPickerModal>(policy: {
  readonly chromeLines: number;
  readonly validateContextCap: boolean;
  readonly extraControls: boolean;
  readonly commitBeforeClose: boolean;
  readonly commit: (state: ModelPickerTokenState<Context, Picker>, selection: PickerSelection<Picker>) => void;
  readonly commitEmbedding?: ((state: ModelPickerTokenState<Context, Picker>, provider: string) => void) | undefined;
  readonly selectSpecial?:
    | ((state: ModelPickerTokenState<Context, Picker>, model: PickerSelection<Picker>['model']) => boolean)
    | undefined;
}) {
  type State = ModelPickerTokenState<Context, Picker>;
  function commitSelection(state: State, selection: PickerSelection<Picker>): void {
    const handled = state.onModelPickerCommit?.() ?? false;
    if (policy.commitBeforeClose) {
      if (!handled) policy.commit(state, selection);
      closeModelPickerRoute(state);
    } else {
      closeModelPickerRoute(state);
      if (!handled) policy.commit(state, selection);
    }
  }
  function readRequestedEffort(state: State): string | undefined {
    const configManager = state.commandContext?.platform?.configManager;
    if (!configManager) return undefined;
    return requestedEffortLevel(configManager) || undefined;
  }
  function effortStepPreselect(
    state: State,
    model: {
      id: string;
      provider?: string | undefined;
      displayName?: string | undefined;
    },
  ): string {
    const requested = readRequestedEffort(state) ?? 'medium';
    return servingEffortForLevel(requested, toEffortModel(model as never)).effective ?? requested;
  }
  function togglePin(state: State): void {
    const model = state.modelPicker.getSelected();
    if (!model) return;
    const pinned = state.modelPicker.togglePinnedLocal(model);
    void state.commandContext?.executeCommand?.(pinned ? 'pin' : 'unpin', [model.registryKey]);
  }
  function cycleCapabilityFilter(modelPicker: ModelPickerModal): void {
    const cycle: CapabilityFilter[] = ['none', 'reasoning', 'toolUse', 'multimodal'];
    const cur = cycle.indexOf(modelPicker.capabilityFilter);
    modelPicker.setCapabilityFilter(cycle[(cur + 1) % cycle.length]!);
  }
  function handleModelPickerToken(state: State, token: InputToken): boolean {
    if (!state.modelPicker.active) return false;
    if (token.type === 'key') {
      if (token.logicalName === 'escape') {
        // Esc pops exactly one level: the effort and context-cap steps and a
        // provider-first model list are sub-levels of the picker; otherwise the
        // picker closes. A typed query is not a level, it goes with the picker.
        if (state.modelPicker.popLevel() === null) {
          state.handleEscape();
          return true;
        }
      } else if (isTextBackspace(token.logicalName ?? '')) {
        if (state.modelPicker.mode === 'contextCap') state.modelPicker.deleteContextCapChar();
        else if (state.modelPicker.canFocusSearch()) state.modelPicker.deleteChar();
      } else if (token.logicalName === 'enter') {
        if (state.modelPicker.focusRegion === 'targets') {
          state.modelPicker.focusItems();
          state.requestRender();
          return true;
        }
        const picker = state.modelPicker;
        if (picker.mode === 'model') {
          const selected = picker.getSelected();
          if (selected) {
            if (policy.selectSpecial?.(state, selected)) return true;
            const currentEffort = readRequestedEffort(state) ?? 'medium';
            if (picker.target === 'main' && offersConfigurableEffort(toEffortModel(selected)))
              picker.showEffortPicker(selected, effortStepPreselect(state, selected));
            else commitSelection(state, { model: selected, effort: currentEffort, target: picker.target });
          }
        } else if (picker.mode === 'provider') {
          const selectedProvider = picker.getFilteredProviders()[picker.selectedIndex];
          if (selectedProvider) {
            const models = state.commandContext
              ? state.commandContext.provider.providerRegistry.getSelectableModels().filter((m) => m.provider === selectedProvider)
              : [];
            picker.showModelsForProvider(models, selectedProvider);
          }
        } else if (picker.mode === 'effort') {
          const model = picker.pendingModel;
          const effort = picker.effortLevels[picker.selectedIndex];
          if (model && effort) commitSelection(state, { model, effort, target: picker.target, effortChosenByUser: true });
          else closeModelPickerRoute(state);
        } else if (picker.mode === 'embeddingProvider') {
          const provider = picker.embeddingProviders[picker.selectedIndex];
          if (provider) policy.commitEmbedding?.(state, provider.id);
          closeModelPickerRoute(state);
        } else if (picker.mode === 'contextCap') {
          const model = picker.contextCapPendingModel;
          if (model) {
            const raw = picker.contextCapQuery.trim();
            const parsed = raw.length ? parseInt(raw, 10) : null;
            if (policy.validateContextCap && parsed !== null && (parsed <= 0 || parsed > 10000000)) {
              picker.contextCapError = 'Context cap must be 1–10,000,000';
            } else {
              if (policy.validateContextCap) picker.contextCapError = null;
              const valid = parsed !== null && parsed > 0 && parsed <= 10000000 ? parsed : null;
              commitSelection(state, { model, effort: readRequestedEffort(state) ?? 'medium', contextCap: valid, target: picker.target });
            }
          } else closeModelPickerRoute(state);
        }
      } else if (token.logicalName === 'up' || token.logicalName === 'down') {
        // The search row is always live, so arrows always walk the list.
        const maxVis = Math.max(5, state.getViewportHeight() - policy.chromeLines - 4);
        state.modelPicker.focusItems();
        if (token.logicalName === 'up') state.modelPicker.moveUp(maxVis);
        else state.modelPicker.moveDown(maxVis);
      } else if (
        (token.logicalName === 'tab' || token.logicalName === 'right' || token.logicalName === 'left') &&
        state.modelPicker.mode !== 'contextCap' &&
        state.modelPicker.mode !== 'effort'
      ) {
        // The five model targets are tabs: tab / → next, shift+tab / ← previous.
        const back = token.logicalName === 'left' || (token.logicalName === 'tab' && token.shift);
        state.modelPicker.moveTarget(back ? -1 : 1);
      } else if (token.ctrl && state.modelPicker.mode === 'model') {
        const picker = state.modelPicker;
        if (token.logicalName === 't') {
          const cycle: CategoryFilter[] = ['all', 'free', 'paid', 'subscription'];
          picker.setCategoryFilter(cycle[(cycle.indexOf(picker.categoryFilter) + 1) % cycle.length]!);
        } else if (token.logicalName === 'k') cycleCapabilityFilter(picker);
        else if (token.logicalName === 'a') picker.toggleAvailableOnly();
        else if (token.logicalName === 'b') picker.cycleBenchmarkSort();
        else if (token.logicalName === 'g') picker.cycleGroupBy();
        else if (policy.extraControls && token.logicalName === 'f') togglePin(state);
        else if (policy.extraControls && token.logicalName === 'r') {
          void state.commandContext?.executeCommand?.('refresh-models', []);
        }
      }
    } else if (token.type === 'text') {
      const picker = state.modelPicker;
      if (picker.mode === 'contextCap') {
        if (token.value.length === 1) picker.appendContextCapChar(token.value);
      } else if (token.value === ' ' && picker.mode === 'model' && picker.query.length === 0) {
        // Space on an untouched search sets a context cap for a local model.
        const selected = picker.getSelected();
        if (selected && picker.isLocalModel(selected)) picker.enterContextCapMode(selected);
      } else if (token.value === '\t') {
        picker.moveTarget(1);
      } else if (picker.canFocusSearch() && !(token.value === '/' && picker.query.length === 0)) {
        // Every printable character goes to the always-live search.
        picker.focusItems();
        picker.focusSearch();
        for (const ch of token.value) if (ch >= ' ') picker.appendChar(ch);
      }
    }
    state.requestRender();
    return true;
  }
  return handleModelPickerToken;
}

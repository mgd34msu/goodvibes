import {
  drawModelWorkspaceDetail,
  modelWorkspaceEmptyLine,
  modelWorkspaceFilterRow,
  modelWorkspaceKey as modelKey,
  modelWorkspaceListAge,
  modelWorkspaceTabs,
  modelWorkspaceTargetLine,
  modelWorkspaceTargetSummary,
  modelWorkspaceProviderRows,
  modelWorkspaceTier,
  MODEL_WORKSPACE_UNKNOWN_KIND,
} from '@goodvibes/engine/terminal-shell/model-workspace-facts';
import { modelPickerTargetLabel } from '@goodvibes/engine/terminal-shell/model-picker-targets';
import { truncateDisplay } from '@goodvibes/engine/platform/platform/utils';
/**
 * The provider/model picker, drawn with the modal surface kit. The tabs, the
 * filter row and the selected model's detail are the terminal app's
 * (terminal-shell model-workspace-facts.ts), so both programs show one picker.
 *
 *   ✦ Models › Main chat › Model list                             esc
 *     Main chat   Other jobs (optional) ▸
 *
 *   ▏Search models                                        12 of 240
 *   ctrl+t price: any   ctrl+k needs: nothing   ctrl+a every model   …
 *
 *   ✦ anthropic                         element panel
 *     Claude Sonnet   200k · paid         Claude Sonnet
 *     ...                                 Provider  anthropic …
 *
 *   ↑↓ move   ⏎ select   tab next job   ctrl+f pin   ctrl+r refresh catalog
 *
 * Tab / ←→ move through the targets, the search row is always live, the list
 * groups models under ✦ headers. Effort and context-cap steps are sub-levels
 * (Esc goes back one). The search index is not a target here: it is set in
 * /settings, and the Other jobs line says so.
 */

import type { ModelDefinition } from '@goodvibes/engine/platform/platform/providers';
import type { ModelPickerModal } from '../input/model-picker.ts';
import type { ModelPickerTargetInfo } from '../input/model-picker.ts';
import { isLocalFitRecommendation, isProviderSignInRow, LOCAL_REC_PROVIDER } from '../input/model-picker-local-fit.ts';
import {
  estimateModelBytes,
  fitAssessment,
  fitVerdictLabel,
  paramCountFromModel,
  readHardwareProfileSync,
  REPRESENTATIVE_7B_PARAMS,
} from '../core/hardware-profile.ts';
import { activeTokens } from './theme.ts';
import { beginModal, finishModal, scrollCountText, searchRow, wrapLines, type KitHint, type SurfaceLayer } from './surface-kit.ts';
import { drawList, type KitRow } from './surface-kit-list.ts';
import { panel, panelLines, type PanelLine } from './surface-kit-parts.ts';
import { drawTabRows, splitPanes, drawTextBlock } from './surface-kit-extra.ts';

/**
 * Rows the picker's chrome takes (title, tabs, search, padding, hints); the
 * key route subtracts it from the viewport height for page-sized moves.
 */
export const MODEL_PICKER_CHROME_LINES = 7;

const MODEL_WORKSPACE_TITLE = 'Models';
const MODEL_WORKSPACE_MODE_LABELS = {
  provider: 'Provider list',
  model: 'Model list',
  effort: 'Reasoning effort',
  contextCap: 'Context cap',
  choice: 'Choose one',
} as const;
const MODEL_WORKSPACE_CHOICE_NEXT = 'Enter asks for its address and where its key comes from, then saves it.';
/** Where the search index is chosen, since the Agent's picker has no tab for it. */
const SEARCH_INDEX_WHERE = 'The search index (how memories are searched) is chosen in /settings open provider.embeddingProvider.';
const MODEL_WORKSPACE_REASONING_EFFORT_DETAIL =
  'Reasoning effort applies to the main chat model. Select the default effort for this model.';
const MODEL_WORKSPACE_CONTEXT_CAP_DETAIL = 'Context cap overrides the detected local-model context window for this selection.';
const MODEL_WORKSPACE_CONTEXT_CAP_INPUT_HELP = 'Type digits to set a cap. Enter confirms; Esc returns to the model list.';
const MODEL_WORKSPACE_LOCAL_ONLY_HEADER = 'No provider signed in, these run on your machine';
const MODEL_WORKSPACE_LOCAL_ONLY_SIGN_IN =
  'Sign in instead: select "Sign in to a provider" in the list below to connect a cloud or local provider.';

/**
 * Returns true when every model in the picker's list is a synthetic local
 * fit recommendation (no real credentials configured).
 */
function isLocalOnlyList(picker: ModelPickerModal): boolean {
  if (picker.mode !== 'model') return false;
  const models = picker.models;
  return models.length > 0 && models.every((m) => m.provider === LOCAL_REC_PROVIDER || isLocalFitRecommendation(m));
}

function formatContext(value: number | undefined): string {
  if (!value) return '-';
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

const targetSummary = (info: ModelPickerTargetInfo): string => modelWorkspaceTargetSummary(info, true);

const targetLabelFor = modelPickerTargetLabel;

function providerSelectionDetail(targetLabel: string): string {
  return `Provider selection: choose a provider, then choose a model for ${targetLabel}.`;
}

/**
 * Format a param count (e.g. 70e9) as a human-readable size token (e.g. '70B', '1.5B').
 * Used to build the sizeDescriptor passed to fitVerdictLabel.
 */
function formatParamDescriptor(params: number): string {
  const b = params / 1e9;
  // Avoid floating-point noise: round to 1 decimal, strip trailing .0
  const rounded = Math.round(b * 10) / 10;
  return rounded === Math.floor(rounded) ? `${Math.floor(rounded)}B` : `${rounded}B`;
}

function modelHardwareFitLine(model: ModelDefinition): string {
  const provider = (model.provider ?? '').toLowerCase();
  // Anchor on known local-provider identities only; cloud providers that happen
  // to serve Llama/local-named models (Groq 'llama-3.1-70b', Together
  // 'meta-llama/...') are NOT local and must not be annotated.
  const isLocal =
    provider === 'ollama' ||
    provider === 'vllm' ||
    provider === 'llama-cpp' ||
    provider === 'llama.cpp' ||
    provider === 'lm-studio' ||
    provider === 'lmstudio' ||
    provider === 'localai' ||
    provider === 'tgi' ||
    provider === 'local-openai' ||
    provider === 'openai-compatible-local';
  if (!isLocal) return '';
  // Use the actual param count from the model id/displayName when parseable;
  // fall back to the shared 7B representative constant otherwise.
  const parsedParams = paramCountFromModel(model);
  const params = parsedParams ?? REPRESENTATIVE_7B_PARAMS;
  const sizeBytes = estimateModelBytes(params);
  // Build a human-readable size descriptor only when we could parse the real size.
  const sizeDescriptor = parsedParams !== null ? formatParamDescriptor(parsedParams) : undefined;
  const label = fitVerdictLabel(fitAssessment(sizeBytes, readHardwareProfileSync()), sizeDescriptor);
  return label ? `Hardware: ${label}` : '';
}

/** The explanation lines for the element panel outside the model list (wrapped by panelLines). */
function detailLines(picker: ModelPickerModal): string[] {
  const target = picker.getSelectedTargetInfo();
  const targetLabel = target?.label ?? targetLabelFor(picker.target);
  const lines: string[] = [];
  lines.push(`${targetLabel}${target && !target.enabled ? ' (off)' : ''}`);
  if (target) lines.push(`Now: ${targetSummary(target)}`);
  if (picker.mode === 'provider') {
    const provider = picker.getFilteredProviders()[picker.selectedIndex] ?? '';
    lines.push(providerSelectionDetail(targetLabel));
    if (provider) lines.push(`Provider: ${provider}`);
    const unreachable = provider ? picker.unreachableProviders.get(provider) : undefined;
    if (unreachable !== undefined) lines.push(`Health: unreachable: ${unreachable}`);
  } else if (picker.mode === 'effort') {
    lines.push(MODEL_WORKSPACE_REASONING_EFFORT_DETAIL);
  } else if (picker.mode === 'choice') {
    if (target?.description) lines.push(target.description);
    const choice = picker.getSelectedChoice();
    if (choice) lines.push(choice.detail ? `${choice.label}: ${choice.detail}` : choice.label);
    if (choice && choice.id !== '__none__') lines.push(MODEL_WORKSPACE_CHOICE_NEXT);
  } else {
    lines.push(MODEL_WORKSPACE_CONTEXT_CAP_DETAIL);
  }
  return lines;
}

/** The model list's panel: the shared detail, with the Agent's local-only lead and hardware fit. */
function drawModelPanel(f: Parameters<typeof drawModelWorkspaceDetail>[0], picker: ModelPickerModal, p: Parameters<typeof drawModelWorkspaceDetail>[2]): void {
  const t = activeTokens();
  const selected = picker.getSelected();
  const lead = isLocalOnlyList(picker) ? [{ text: MODEL_WORKSPACE_LOCAL_ONLY_HEADER, fg: t.text }, { text: MODEL_WORKSPACE_LOCAL_ONLY_SIGN_IN, fg: t.textMuted }] : [];
  if (selected && (isProviderSignInRow(selected) || isLocalFitRecommendation(selected))) {
    // A placeholder row is not a catalog model: say what it does, nothing more.
    const lines = isProviderSignInRow(selected) ? ['Sign in to a provider to connect a cloud or local model.'] : [selected.displayName];
    if (selected.description) lines.push(selected.description);
    const shown: PanelLine[] = [
      ...lead.map((line) => ({ text: line.text, style: { fg: line.fg } })),
      ...lines.map((text, k) => ({ text, style: { fg: k === 0 ? t.text : t.textMuted, bold: k === 0 } })),
    ];
    panelLines(f.canvas, p, p.l, p.top, shown);
    return;
  }
  const fit = selected ? modelHardwareFitLine(selected) : '';
  drawModelWorkspaceDetail(f, picker, p, {
    lead,
    extra: fit ? [{ text: fit, fg: t.info }] : [],
    listAge: selected ? modelWorkspaceListAge(picker.listReading(selected.provider), Date.now()) : undefined,
  });
}

/** Keycap hints for a picker step. */
function hintsFor(mode: ModelPickerModal['mode'], localSelected = false): KitHint[] {
  if (mode === 'choice')
    return [
      ['↑↓', 'move'],
      ['⏎', 'select'],
      ['tab', 'next job'],
    ];
  if (mode === 'effort')
    return [
      ['↑↓', 'move'],
      ['⏎', 'use this effort'],
    ];
  if (mode === 'contextCap')
    return [
      ['0-9', 'type a cap'],
      ['⏎', 'confirm'],
    ];
  if (mode === 'provider')
    return [
      ['↑↓', 'move'],
      ['⏎', 'show models'],
      ['tab', 'next job'],
    ];
  // The filter keys are under the search field, each with what it is set to.
  return [
    ['↑↓', 'move'],
    ['⏎', 'select'],
    ['tab', 'next job'],
    ['ctrl+f', 'pin'],
    ['ctrl+r', 'refresh catalog'],
    ...(localSelected ? [['space', 'context cap'] as KitHint] : []),
  ];
}

function capabilityText(model: ModelDefinition): string {
  const caps = model.capabilities ?? {};
  return [caps.reasoning ? 'reasoning' : '', caps.multimodal ? 'vision' : '', caps.toolCalling ? 'tools' : ''].filter(Boolean).join(' ');
}

/** The muted row shown while the catalog is still loading behind an open picker. */
const LOADING_ROW: KitRow = { label: 'loading catalog…', muted: true };

function modelRows(picker: ModelPickerModal): KitRow[] {
  const t = activeTokens();
  const rows: KitRow[] = [];
  let lastGroup = '';
  picker.getFilteredModels().forEach((model, index) => {
    const group = picker.getModelGroupKey(model);
    if (group && group !== lastGroup) {
      rows.push({ header: group });
      lastGroup = group;
    }
    const synthetic = isProviderSignInRow(model) || isLocalFitRecommendation(model);
    // A tier nothing states (the catalog not loaded yet, say) is not shown: it is not known to be paid.
    const tier = synthetic ? '' : modelWorkspaceTier(model);
    const right = synthetic ? undefined : [formatContext(model.contextWindow), tier].filter((part): part is string => Boolean(part)).join(' · ');
    const kind = picker.textWork(model) === 'unknown' ? MODEL_WORKSPACE_UNKNOWN_KIND : '';
    // On the recommended short list: why, in place of the capability words.
    const why = picker.recommendedWhy(model);
    rows.push({
      label: model.displayName,
      desc: synthetic ? undefined : [modelKey(model), why ?? capabilityText(model), kind].filter(Boolean).join(' · '),
      right,
      rightFg: tier === 'free' ? t.success : undefined,
      mark: picker.pinnedIds.has(model.id) ? '★' : undefined,
      markFg: t.warning,
      selected: index === picker.selectedIndex,
    });
  });
  return rows;
}

const providerRows = (picker: ModelPickerModal): KitRow[] =>
  modelWorkspaceProviderRows(picker, { unconfiguredColor: activeTokens().textFaint });

/** A target's own entries (the decision model): the one in force is marked. */
function choiceRows(picker: ModelPickerModal): KitRow[] {
  const t = activeTokens();
  return picker.getChoices().map((choice, index) => ({
    label: choice.label,
    desc: choice.id === '__none__' ? undefined : choice.detail,
    mark: choice.current ? '●' : undefined,
    markFg: t.brand,
    selected: index === picker.selectedIndex,
  }));
}

function effortRows(picker: ModelPickerModal): KitRow[] {
  return picker.effortLevels.map((effort, index) => ({
    label: effort,
    detail: picker.effortDetails.get(effort),
    selected: index === picker.selectedIndex,
  }));
}

/**
 * Render the model picker as a SurfaceLayer in screen coordinates.
 */
export function renderModelWorkspace(picker: ModelPickerModal, screenWidth: number, screenHeight: number): SurfaceLayer {
  const t = activeTokens();
  const target = picker.getSelectedTargetInfo();
  const targetLabel = target?.label ?? targetLabelFor(picker.target);
  const selectedForHints = picker.mode === 'model' ? picker.getSelected() : null;
  const f = beginModal(screenWidth, screenHeight, {
    title: MODEL_WORKSPACE_TITLE,
    crumbs: [targetLabel, MODEL_WORKSPACE_MODE_LABELS[picker.mode]],
    hints: hintsFor(picker.mode, selectedForHints ? picker.isLocalModel(selectedForHints) : false),
  });

  let top = f.top;
  // Target tabs: Main chat, and the optional jobs behind one tab until one of them is chosen (shared with the terminal app).
  if (picker.targetInfos.length > 0) {
    const shown = modelWorkspaceTabs(picker);
    top += drawTabRows(f.canvas, f.l, top, shown.labels, shown.active, f.r);
    const about = modelWorkspaceTargetLine(target);
    if (about) {
      for (const line of [...wrapLines(about, f.r - f.l + 1).slice(0, 2), SEARCH_INDEX_WHERE]) f.canvas.put(f.l, top++, truncateDisplay(line, f.r - f.l + 1), { fg: t.textMuted });
    }
    top += 1;
  }

  const searchable = picker.mode === 'model' || picker.mode === 'provider';
  if (searchable) {
    // Out of the models this target can use: an image, video or speech model is not counted.
    const total = picker.mode === 'model' ? picker.models.filter((model) => picker.textWork(model) !== 'other').length : picker.providers.length;
    const shown = picker.mode === 'model' ? picker.getFilteredModels().length : picker.getFilteredProviders().length;
    const counted = picker.query.length > 0 || shown !== total ? `${shown} of ${total}` : `${total} ${picker.mode === 'model' ? 'models' : 'providers'}`;
    const count = picker.mode === 'model' && picker.availableOnly ? `only models you can use · ${counted}` : counted;
    searchRow(f, top, picker.query, picker.mode === 'model' ? 'Search models' : 'Search providers', count);
    top += 2;
    if (picker.mode === 'model') {
      // Each filter key with what it is set to; two rows when one does not hold them.
      const rows = wrapLines(modelWorkspaceFilterRow(picker), f.r - f.l + 1).slice(0, 2);
      rows.forEach((text, k) => f.canvas.put(f.l, top - 1 + k, text, { fg: t.textFaint }));
      top += rows.length;
    }
  }

  const split = splitPanes(f.l, f.r, top, f.bottom, 0.5);
  const p = panel(f.canvas, split.panelX, split.panelY, split.panelW, split.panelH);
  if (picker.mode === 'model') {
    drawModelPanel(f, picker, p);
  } else {
    const details: PanelLine[] = detailLines(picker).map((text, k) => ({ text, style: { fg: k === 0 ? t.text : t.textMuted, bold: k === 0 } }));
    panelLines(f.canvas, p, p.l, p.top, details);
  }

  if (picker.mode === 'contextCap') {
    const model = picker.contextCapPendingModel;
    const input = picker.contextCapQuery.length > 0 ? `${picker.contextCapQuery}▏` : '▏(use detected context)';
    drawTextBlock(
      f.canvas,
      split.x0,
      split.top,
      split.x1 - split.x0 + 1,
      [
        { text: `Model: ${model ? modelKey(model) : '(none)'}`, style: { fg: t.text } },
        { text: `Detected context: ${formatContext(model?.contextWindow)}`, style: { fg: t.textMuted } },
        { text: `Override: ${input}`, style: { fg: t.brand, bold: true } },
        { text: '' },
        ...(picker.contextCapError ? [{ text: picker.contextCapError, style: { fg: t.error } }] : []),
        { text: MODEL_WORKSPACE_CONTEXT_CAP_INPUT_HELP, style: { fg: t.textFaint } },
      ],
      split.bottom,
    );
    return finishModal(f);
  }

  const listed =
    picker.mode === 'model'
      ? modelRows(picker)
      : picker.mode === 'provider'
        ? providerRows(picker)
        : picker.mode === 'choice'
          ? choiceRows(picker)
          : effortRows(picker);
  // The picker opens on its cached catalog; the rest fills in while this row shows.
  const rows = picker.catalogLoading && picker.mode !== 'effort' ? [LOADING_ROW, ...listed] : listed;
  if (rows.length === 0) {
    // An empty model list says when it was read (the picker read it again by itself) and why it is empty.
    const message = picker.mode === 'provider' ? 'No providers match the search.' : modelWorkspaceEmptyLine(picker);
    drawTextBlock(f.canvas, split.x0, split.top, split.x1 - split.x0 + 1, [{ text: message, style: { fg: t.textMuted } }], split.bottom);
    return finishModal(f);
  }
  const res = drawList(f.canvas, {
    rows,
    top: split.top,
    bottom: split.bottom,
    x0: split.x0,
    x1: split.x1,
    scrollKey: { owner: picker, name: picker.mode },
  });
  f.hintRight = scrollCountText(res.above, res.below);
  return finishModal(f);
}

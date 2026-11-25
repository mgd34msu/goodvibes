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
/**
 * renderModelWorkspace, the model picker drawn with the surface kit.
 *
 *   ✦ Models                                                      esc
 *
 *    Main chat   Other jobs (optional) ▸
 *
 *   ▏opus                                                  6 of 5,582
 *   ctrl+t price: any   ctrl+k needs: nothing   ctrl+a every model   …
 *
 *   ✦ pinned                               ┌ element inset ──────────┐
 *   ● Claude Opus 5.5  anthropic    1.0M     Claude Opus 5.5
 *   ✦ recent                                 anthropic:claude-opus-5-5
 *     route-llm        abacusai     8.2K     Context  ▰▰▰▰▰▰▰▰▰▰ 1.0M
 *   ✦ lm studio                              Quality  ▰▰▰▰▰▰▱▱▱▱ 0.61
 *     qwen3-coder       lmstudio    128K     Cost     $15 / $75 per 1M
 *
 *   ⏎ use for Main chat   tab next job   ctrl+f pin   ctrl+r refresh
 *
 * The targets are tabs: Main chat, and the optional jobs behind one tab until
 * one is chosen (model-workspace-facts.ts, shared with the Agent). The filter
 * keys sit under the search field with what each is set to. A model target lists only models the catalog says read
 * and write text; models it does not describe come last, marked. The search
 * index and the decision model list their own entries. The list is grouped
 * Pinned, Recent, then by
 * the group-by mode (provider by default, which includes LAN servers). The
 * detail inset shows the selected model with meters for context, benchmark
 * quality and price where that data exists, its capabilities, which targets it
 * serves, and the picker's active filters. Provider, effort, context-cap and
 * embedding-provider steps use the same frame.
 */

import type { ModelDefinition } from '@goodvibes/engine/platform/platform/providers';
import type { ModelPickerModal, ModelPickerTargetInfo } from '../input/model-picker.ts';
import { abbreviateCount } from '../utils/format-number.ts';
import { activeTokens } from './theme.ts';
import {
  beginModal,
  finishModal,
  modalInnerWidth,
  scrollCountText,
  standardModalWidth,
  searchRow,
  wrapLines,
  type KitHint,
  type ModalFrame,
  type SurfaceLayer,
} from './surface-kit.ts';
import { drawList, type KitListResult, type KitRow } from './surface-kit-list.ts';
import { inset, insetPut, insetWrap, tabs, type KitInset } from './surface-kit-parts.ts';
/**
 * Rows the picker's chrome takes (title, tabs, search, padding, hints); the
 * key route subtracts it from the viewport height for page-sized moves.
 */
export const MODEL_PICKER_CHROME_LINES = 8;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatContext(value: number | undefined): string {
  if (!value) return '-';
  return abbreviateCount(value, { rounding: 'round', decimals: 0 });
}

const targetSummary = (info: ModelPickerTargetInfo): string => modelWorkspaceTargetSummary(info, true);

const targetLabelFor = modelPickerTargetLabel;

function isTargetModel(info: ModelPickerTargetInfo | null, model: ModelDefinition): boolean {
  if (!info || !info.enabled) return false;
  return info.model === model.registryKey || (info.model === model.id && (!info.provider || info.provider === model.provider));
}

// ---------------------------------------------------------------------------
// List rows per mode
// ---------------------------------------------------------------------------

/** Model rows; without a detail inset the selected row names its full key instead of the provider. */
/** The muted row shown while the catalog is still loading behind an open picker. */
const LOADING_ROW: KitRow = { label: 'loading catalog…', muted: true, selectable: false };

function modelRows(picker: ModelPickerModal, compact = false): KitRow[] {
  const t = activeTokens();
  const models = picker.getFilteredModels();
  const target = picker.getSelectedTargetInfo();
  const recent = new Set(picker.recentIds);
  const rows: KitRow[] = [];
  let section = '';
  models.forEach((model, index) => {
    const group = picker.isPinned(model) ? 'Pinned' : recent.has(model.id) ? 'Recent' : picker.getModelGroupKey(model);
    if (group !== section) {
      rows.push({ header: group });
      section = group;
    }
    const current = isTargetModel(target, model);
    const selected = index === picker.selectedIndex;
    const where = compact && selected ? modelKey(model) : model.provider;
    const why = picker.recommendedWhy(model);
    const tier = modelWorkspaceTier(model);
    rows.push({
      label: model.displayName || model.id,
      desc: [where, why ?? (picker.textWork(model) === 'unknown' ? MODEL_WORKSPACE_UNKNOWN_KIND : undefined)].filter(Boolean).join(' · '),
      // The price tier beside the context, so a free model is told apart without opening it.
      right: tier ? `${formatContext(model.contextWindow)} · ${tier}` : formatContext(model.contextWindow),
      rightFg: tier === 'free' ? t.success : undefined,
      mark: current ? '●' : undefined,
      markFg: t.brand,
      current,
      selected,
    });
  });
  if (rows.length === 0 && !picker.catalogLoading)
    rows.push({ label: modelWorkspaceEmptyLine(picker), muted: true });
  return rows;
}

const providerRows = (picker: ModelPickerModal): KitRow[] =>
  modelWorkspaceProviderRows(picker, { unconfiguredColor: activeTokens().warning, groupedItems: picker.getItems() });

/**
 * A row's `detail` makes the list reserve a help area above its rows, as tall as the longest detail, for the
 * selected row's detail; beside the detail inset (sideBySide) the inset already shows it, so the rows carry none.
 */
function embeddingRows(picker: ModelPickerModal, sideBySide: boolean): KitRow[] {
  const t = activeTokens();
  if (picker.embeddingProviders.length === 0)
    return picker.catalogLoading ? [] : [{ label: 'No embedding providers are registered.', muted: true }];
  return picker.embeddingProviders.map((provider, index) => ({
    label: provider.label,
    detail: sideBySide ? undefined : provider.detail,
    right: `${provider.dimensions}d · ${provider.configured ? 'configured' : 'unconfigured'}`,
    rightFg: provider.configured ? undefined : t.warning,
    mark: provider.configured ? '●' : '○',
    markFg: provider.configured ? t.success : t.warning,
    selected: index === picker.selectedIndex,
  }));
}

/** A target's own entries (the decision model): the one in force is marked. */
function choiceRows(picker: ModelPickerModal): KitRow[] {
  const t = activeTokens();
  return picker.getChoices().map((choice, index) => ({
    label: choice.label,
    desc: choice.id === '__none__' ? undefined : choice.detail,
    mark: choice.current ? '●' : undefined,
    markFg: t.brand,
    current: choice.current,
    selected: index === picker.selectedIndex,
  }));
}

/**
 * The effort step: exactly the levels the chosen model resolved to, introduced
 * by a headline naming what the model does with the setting. A best-guess spec
 * prints its caveat under the list rather than presenting unverified levels as
 * confirmed; a model with nothing to configure gets a statement, not a list.
 */
function effortRows(picker: ModelPickerModal): KitRow[] {
  const t = activeTokens();
  const presentation = picker.effortPresentation;
  const rows: KitRow[] = [];
  if (presentation) rows.push({ label: presentation.headline, selectable: false, labelFg: t.accent });
  if (presentation && !presentation.configurable) {
    rows.push({ label: 'Esc returns to the model list.', selectable: false, labelFg: t.textFaint });
    return rows;
  }
  picker.effortLevels.forEach((effort, index) => {
    rows.push({ label: effort, detail: presentation?.choices[index]?.description || undefined, selected: index === picker.selectedIndex });
  });
  if (presentation?.caveat && picker.effortLevels.length > 0)
    rows.push({ label: presentation.caveat, selectable: false, labelFg: t.textFaint });
  return rows;
}

// ---------------------------------------------------------------------------
// Detail inset
// ---------------------------------------------------------------------------

/** Active filters in a few words, '' when none are set. */
function filterSummary(picker: ModelPickerModal): string {
  const parts: string[] = [];
  if (picker.categoryFilter !== 'all') parts.push(`${picker.categoryFilter} only`);
  if (picker.capabilityFilter !== 'none') parts.push(`needs ${picker.capabilityFilter}`);
  if (picker.availableOnly) parts.push('only models you can use');
  if (picker.benchmarkSort !== 'none') parts.push(`sorted by ${picker.benchmarkSort}`);
  if (picker.groupBy !== 'provider') parts.push(`grouped by ${picker.groupBy}`);
  return parts.join(' · ');
}

function kv(canvas: ModalFrame['canvas'], p: KitInset, y: number, key: string, value: string, fg?: string): number {
  const t = activeTokens();
  if (y > p.bottom) return y;
  insetPut(canvas, p, p.l, y, key, { fg: t.textMuted });
  return insetWrap(canvas, p, p.l + 12, y, value, { fg: fg ?? t.text });
}

function drawModelDetail(f: ModalFrame, picker: ModelPickerModal, p: KitInset): void {
  const model = picker.getSelected();
  const listAge = model ? modelWorkspaceListAge(picker.listReading(model.provider), Date.now()) : undefined;
  const y = drawModelWorkspaceDetail(f, picker, p, { listAge });
  drawTargetFooter(f, picker, p, y);
}

function drawTargetFooter(f: ModalFrame, picker: ModelPickerModal, p: KitInset, fromY: number): void {
  const t = activeTokens();
  const target = picker.getSelectedTargetInfo();
  const lines: Array<{ text: string; fg: string }> = [];
  const width = p.r - p.l + 1;
  if (target && picker.mode !== 'model') {
    for (const l of wrapLines(`${target.label}: ${targetSummary(target)}`, width)) lines.push({ text: l, fg: t.textMuted });
    if (target.description) for (const l of wrapLines(target.description, width)) lines.push({ text: l, fg: t.textFaint });
  }
  // Pinned to the bottom of the inset when there is room, else right after the content.
  let y = Math.max(fromY, p.bottom - lines.length + 1);
  for (const line of lines) {
    if (y > p.bottom) break;
    insetPut(f.canvas, p, p.l, y++, line.text, { fg: line.fg });
  }
}

function drawStepDetail(f: ModalFrame, picker: ModelPickerModal, p: KitInset): void {
  const t = activeTokens();
  const c = f.canvas;
  let y = p.top;
  if (picker.mode === 'provider') {
    const provider = picker.getFilteredProviders()[picker.selectedIndex] ?? '';
    const target = picker.getSelectedTargetInfo();
    y = insetWrap(c, p, p.l, y, provider || 'No provider selected', { fg: t.text, bold: true });
    y++;
    y = insetWrap(c, p, p.l, y, `Choose a provider, then choose a model for ${target?.label ?? targetLabelFor(picker.target)}.`, {
      fg: t.textMuted,
    });
    if (provider) {
      const via = picker.configuredViaMap.get(provider);
      y = kv(
        c,
        p,
        y + 1,
        'Status',
        picker.configuredProviders.has(provider) ? `configured${via ? ` via ${via}` : ''}` : 'not configured',
        picker.configuredProviders.has(provider) ? t.success : t.warning,
      );
      const unreachable = picker.unreachableProviders.get(provider);
      if (unreachable !== undefined) y = kv(c, p, y, 'Health', `unreachable: ${unreachable}`, t.warning);
      y = kv(c, p, y, 'Models', String(picker.models.filter((m) => m.provider === provider).length));
    }
  } else if (picker.mode === 'embeddingProvider') {
    const selected = picker.embeddingProviders[picker.selectedIndex];
    y = insetWrap(c, p, p.l, y, 'Search index service', { fg: t.text, bold: true });
    y = insetWrap(c, p, p.l, y + 1, 'The provider memory search and the code index use to embed content.', { fg: t.textMuted });
    if (selected) {
      y = kv(c, p, y + 1, 'Provider', selected.id);
      y = kv(c, p, y, 'Dimensions', String(selected.dimensions));
      y = kv(c, p, y, 'Status', selected.configured ? 'configured' : 'unconfigured', selected.configured ? t.success : t.warning);
      if (selected.detail) y = insetWrap(c, p, p.l, y + 1, selected.detail, { fg: t.textMuted });
    }
  } else if (picker.mode === 'choice') {
    const choice = picker.getSelectedChoice();
    y = insetWrap(c, p, p.l, y, choice?.label ?? 'Nothing is selected.', { fg: t.text, bold: true });
    if (choice?.detail) y = insetWrap(c, p, p.l, y + 1, choice.detail, { fg: t.textMuted });
    if (choice && choice.id !== '__none__')
      y = insetWrap(c, p, p.l, y + 1, 'Enter asks for its address and where its key comes from, then saves it.', { fg: t.textFaint });
  } else if (picker.mode === 'effort') {
    const model = picker.pendingModel;
    y = insetWrap(c, p, p.l, y, model ? model.displayName || model.id : 'Reasoning effort', { fg: t.text, bold: true });
    if (model) y = insetWrap(c, p, p.l, y, modelKey(model), { fg: t.textFaint });
    y = insetWrap(c, p, p.l, y + 1, 'Reasoning effort applies to the main chat model. Select the default effort for this model.', {
      fg: t.textMuted,
    });
  }
  drawTargetFooter(f, picker, p, y + 1);
}

/** The context-cap step: a small form in the list area. */
function drawContextCap(f: ModalFrame, picker: ModelPickerModal, top: number, x0: number, x1: number): void {
  const t = activeTokens();
  const model = picker.contextCapPendingModel;
  const width = x1 - x0 + 1;
  let y = top;
  const line = (text: string, fg: string, bold = false): void => {
    for (const l of wrapLines(text, width)) if (y <= f.bottom) f.canvas.put(x0, y++, l, { fg, bold });
  };
  line(`Model: ${model ? modelKey(model) : '(none)'}`, t.text);
  line(`Detected context: ${formatContext(model?.contextWindow)}`, t.textMuted);
  y++;
  const input = picker.contextCapQuery.length > 0 ? picker.contextCapQuery : '';
  if (y <= f.bottom) {
    const end = f.canvas.put(x0, y, 'Override  ', { fg: t.textMuted });
    const typed = f.canvas.put(end, y, input, { fg: t.text, bold: true });
    f.canvas.put(typed, y, '▏', { fg: t.brand });
    if (!input) f.canvas.put(typed + 1, y, 'uses the detected context', { fg: t.textFaint });
    y += 2;
  }
  if (picker.contextCapError) line(picker.contextCapError, t.error);
  line('Type digits to set a cap. Enter confirms; Esc returns to the model list.', t.textFaint);
}

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

function pickerHints(picker: ModelPickerModal): KitHint[] {
  const target = picker.getSelectedTargetInfo()?.label ?? targetLabelFor(picker.target);
  switch (picker.mode) {
    case 'effort':
      return [
        ['↑↓', 'move'],
        ['⏎', 'use this effort'],
        ['esc', 'back to models'],
      ];
    case 'contextCap':
      return [
        ['0-9', 'cap'],
        ['⏎', 'confirm'],
        ['esc', 'back to models'],
      ];
    case 'embeddingProvider':
    case 'choice':
      return [
        ['↑↓', 'move'],
        ['⏎', `use for ${target}`],
        ['tab', 'next job'],
      ];
    case 'provider':
      return [
        ['↑↓', 'move'],
        ['⏎', 'choose provider'],
        ['tab', 'next job'],
      ];
    default:
      // The filter keys are under the search field, each with what it is set to.
      return [
        ['⏎', `use for ${target}`],
        ['tab', 'next job'],
        ['ctrl+f', 'pin'],
        ['ctrl+r', 'refresh catalog'],
      ];
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const renderCache = new WeakMap<ModelPickerModal, { key: string; tokens: object; layer: SurfaceLayer }>();

export function renderModelWorkspace(picker: ModelPickerModal, screenWidth: number, screenHeight: number): SurfaceLayer {
  const cacheKey = getRenderCacheKey(picker, screenWidth, screenHeight);
  const cached = renderCache.get(picker);
  if (cached?.key === cacheKey && cached.tokens === activeTokens()) return cached.layer;

  const pending = picker.mode === 'effort' ? picker.pendingModel : picker.mode === 'contextCap' ? picker.contextCapPendingModel : null;
  const crumbs =
    picker.mode === 'effort'
      ? [pending?.displayName ?? 'model', 'Reasoning effort']
      : picker.mode === 'contextCap'
        ? [pending?.displayName ?? 'model', 'Context cap']
        : picker.mode === 'provider'
          ? ['Providers']
          : undefined;
  const inner = modalInnerWidth(standardModalWidth(screenWidth));
  const sideBySide = inner >= 60;
  const f = beginModal(screenWidth, screenHeight, { title: 'Models', crumbs, hints: pickerHints(picker) });

  // Targets as tabs; the active tab carries the gradient. Main chat, and the optional jobs behind one tab
  // until one of them is chosen; then they are listed, each marked "(off)" when it is off.
  let body = f.top + 2;
  if (picker.targetInfos.length > 0) {
    const shown = modelWorkspaceTabs(picker);
    tabs(f.canvas, f.l, f.top, shown.labels, shown.active, f.r, (index) => {
      const target = picker.targetInfos[shown.targetAt(index)];
      if (target) picker.setTarget(target.target);
    });
    const about = modelWorkspaceTargetLine(picker.getSelectedTargetInfo());
    if (about) {
      // What the chosen job does, in at most two rows.
      const rows = wrapLines(about, f.r - f.l + 1).slice(0, 2);
      rows.forEach((text, k) => f.canvas.put(f.l, f.top + 1 + k, text, { fg: activeTokens().textMuted }));
      body += rows.length;
    }
  } else {
    tabs(f.canvas, f.l, f.top, [targetLabelFor(picker.target)], 0, f.r);
  }

  const searchable = picker.mode === 'model' || picker.mode === 'provider';
  if (searchable) {
    // Out of the models this target can use: an image, video or speech model is not counted.
    const total = picker.mode === 'model' ? picker.models.filter((model) => picker.textWork(model) !== 'other').length : picker.providers.length;
    const shown = picker.getItemCount();
    const counted =
      picker.query.length > 0 || shown !== total
        ? `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`
        : `${total.toLocaleString('en-US')} ${picker.mode === 'model' ? 'models' : 'providers'}`;
    const filters = picker.mode === 'model' ? filterSummary(picker) : '';
    const count = filters ? `${filters} · ${counted}` : counted;
    searchRow(f, body, picker.query, picker.mode === 'model' ? 'Search models' : 'Search providers', count);
    body += 2;
    if (picker.mode === 'model') {
      // Each filter key with what it is set to; two rows when one does not hold them.
      const rows = wrapLines(modelWorkspaceFilterRow(picker), f.r - f.l + 1).slice(0, 2);
      rows.forEach((text, k) => f.canvas.put(f.l, body - 1 + k, text, { fg: activeTokens().textFaint }));
      body += rows.length;
    }
  }

  const x1 = sideBySide ? f.l + Math.floor(inner * 0.5) - 1 : f.r;
  let result: KitListResult | null = null;
  const scrollKey = { owner: picker, name: picker.mode };
  if (picker.mode === 'contextCap') {
    drawContextCap(f, picker, body, f.l, x1);
  } else {
    const listed =
      picker.mode === 'model'
        ? modelRows(picker, !sideBySide)
        : picker.mode === 'provider'
          ? providerRows(picker)
          : picker.mode === 'embeddingProvider'
            ? embeddingRows(picker, sideBySide)
            : picker.mode === 'choice'
              ? choiceRows(picker)
              : effortRows(picker);
    // The picker opens on its cached catalog; the rest fills in while this row shows.
    const rows = picker.catalogLoading && picker.mode !== 'effort' ? [LOADING_ROW, ...listed] : listed;
    result = drawList(f.canvas, { mouseNavigation: true, rows, top: body, bottom: f.bottom, x0: f.l, x1, scrollKey });
  }
  if (sideBySide) {
    const p = inset(f.canvas, x1 + 3, body, f.r + 2 - (x1 + 3) + 1, f.bottom - body + 1);
    if (picker.mode === 'model' || picker.mode === 'contextCap') drawModelDetail(f, picker, p);
    else drawStepDetail(f, picker, p);
  }
  if (result) f.hintRight = scrollCountText(result.above, result.below);
  const layer = finishModal(f);
  renderCache.set(picker, { key: cacheKey, tokens: activeTokens(), layer });
  return layer;
}

// ---------------------------------------------------------------------------
// Render cache key (the catalog can hold thousands of models)
// ---------------------------------------------------------------------------

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

function getRenderCacheKey(picker: ModelPickerModal, width: number, height: number): string {
  const base: Array<string | number> = [
    width,
    height,
    picker.mode,
    picker.target,
    picker.targetIndex,
    picker.query,
    picker.selectedIndex,
    picker.categoryFilter,
    picker.capabilityFilter,
    picker.availableOnly ? 1 : 0,
    picker.benchmarkSort,
    picker.groupBy,
    picker.contextCapError ?? '',
    keyForSet(picker.pinnedIds),
    picker.recentIds.join('\u001f'),
    keyForSet(picker.configuredProviders),
    keyForMap(picker.configuredViaMap),
    keyForTargets(picker.targetInfos),
    picker.catalogLoading ? 1 : 0,
  ];
  if (picker.mode === 'model') {
    const filtered = picker.getFilteredModels();
    const selected = filtered[picker.selectedIndex];
    base.push(objectId(picker.models), objectId(filtered), filtered.length, selected?.registryKey ?? selected?.id ?? '');
  } else if (picker.mode === 'provider') {
    const filteredProviders = picker.getFilteredProviders();
    base.push(objectId(picker.providers), objectId(filteredProviders), filteredProviders.length);
  } else if (picker.mode === 'effort') {
    base.push(
      objectId(picker.effortLevels),
      picker.effortLevels.join('\u001f'),
      picker.pendingModel?.registryKey ?? picker.pendingModel?.id ?? '',
      // The headline and caveat are rendered content too.
      picker.effortPresentation?.headline ?? '',
      picker.effortPresentation?.caveat ?? '',
    );
  } else if (picker.mode === 'contextCap') {
    base.push(picker.contextCapQuery, picker.contextCapPendingModel?.registryKey ?? picker.contextCapPendingModel?.id ?? '');
  } else if (picker.mode === 'embeddingProvider') {
    base.push(objectId(picker.embeddingProviders), picker.embeddingProviders.length);
  } else if (picker.mode === 'choice') {
    base.push(picker.getChoices().map((choice) => `${choice.id}\u001d${choice.current ? 1 : 0}`).join('\u001f'));
  }
  return base.join('\u001e');
}

function objectId(value: object): number {
  const existing = objectIds.get(value);
  if (existing !== undefined) return existing;
  const next = nextObjectId++;
  objectIds.set(value, next);
  return next;
}

function keyForSet(values: ReadonlySet<string>): string {
  return values.size === 0 ? '' : [...values].sort().join('\u001f');
}

function keyForMap(values: ReadonlyMap<string, string | undefined>): string {
  if (values.size === 0) return '';
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\u001d${value ?? ''}`)
    .join('\u001f');
}

function keyForTargets(values: readonly ModelPickerTargetInfo[]): string {
  return values
    .map((entry) =>
      [
        entry.target,
        entry.label,
        entry.description,
        entry.provider,
        entry.model,
        entry.enabled ? 1 : 0,
        entry.inherited ? 1 : 0,
        entry.configuredNote ?? '',
      ].join('\u001d'),
    )
    .join('\u001f');
}

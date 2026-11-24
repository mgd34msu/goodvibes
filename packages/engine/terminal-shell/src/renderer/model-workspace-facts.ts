import { MODEL_PRICE_TIER_WORDS, modelPriceTier, type ModelDefinition } from '@goodvibes/engine/platform/platform/providers';
import type { KitRow } from './surface-kit-list.js';
import type { ModalFrame } from './surface-kit.js';
import { insetPut, insetWrap, meter, type KitInset } from './surface-kit-parts.js';
import { activeTokens } from './theme.js';
import { abbreviateCount } from '../format.js';
import { modelPickerTargetLabel } from '../model-picker-targets.js';
import type { ModelPickerModal } from '../model-picker.js';
import type { ModelPickerTargetInfo } from '../model-picker-types.js';

// ---------------------------------------------------------------------------
// One model picker, both terminal programs: the target tabs, the filter row,
// the words for a model the catalog does not describe, the price tier, the
// list's age and the detail pane are drawn from here.
// ---------------------------------------------------------------------------

/** A model the catalog does not describe, beside its provider in the list. */
export const MODEL_WORKSPACE_UNKNOWN_KIND = 'not in the catalog';

/** The same, in full, in the detail pane: what it means and what to do. */
export const MODEL_WORKSPACE_UNKNOWN_KIND_DETAIL = 'Not described by the model catalog; usable as a text model, listed after the described ones.';

/**
 * The target tabs. Main chat is the one choice most people make, so the
 * optional jobs (side work, tool work, spoken replies, the search index, the
 * decision model) sit behind one tab, `Other jobs (optional) ▸`, until one of
 * them is chosen; then they are listed, each marked `(off)` when it is off.
 * Tab and ←→ still move through every target in order.
 */
export function modelWorkspaceTabs(picker: Pick<ModelPickerModal, 'targetIndex'> & { readonly targetInfos: readonly ModelPickerTargetInfo[] }): {
  readonly labels: readonly string[];
  readonly active: number;
  /** The targetInfos index a tab selects. */
  readonly targetAt: (tab: number) => number;
} {
  const infos = picker.targetInfos;
  const main = Math.max(0, infos.findIndex((info) => info.target === 'main'));
  const others = infos.map((_, index) => index).filter((index) => index !== main);
  if (others.length === 0 || picker.targetIndex === main) {
    return {
      labels: [infos[main]?.label ?? modelPickerTargetLabel('main'), ...(others.length > 0 ? ['Other jobs (optional) ▸'] : [])],
      active: 0,
      targetAt: (tab) => (tab === 0 ? main : others[0] ?? main),
    };
  }
  return {
    labels: [infos[main]?.label ?? modelPickerTargetLabel('main'), ...others.map((index) => `${infos[index]!.label}${infos[index]!.enabled ? '' : ' (off)'}`)],
    active: 1 + Math.max(0, others.indexOf(picker.targetIndex)),
    targetAt: (tab) => (tab === 0 ? main : others[tab - 1] ?? main),
  };
}

/**
 * The line under the tabs while an optional job is chosen: what it does, and
 * whose model it uses when none is chosen for it.
 */
export function modelWorkspaceTargetLine(info: ModelPickerTargetInfo | null): string | undefined {
  if (!info || info.target === 'main') return undefined;
  const state = !info.enabled ? ' It is off.' : info.inherited ? ' None chosen: it uses the Main chat model.' : '';
  return `${info.description}${state}`;
}

/** The filter keys with what each is set to now, for the row under the search field. */
export function modelWorkspaceFilterRow(picker: Pick<ModelPickerModal, 'categoryFilter' | 'capabilityFilter' | 'availableOnly' | 'benchmarkSort' | 'groupBy'>): string {
  return [
    `ctrl+t price: ${picker.categoryFilter === 'all' ? 'any' : picker.categoryFilter}`,
    `ctrl+k needs: ${picker.capabilityFilter === 'none' ? 'any' : picker.capabilityFilter}`,
    `ctrl+a ${picker.availableOnly ? 'usable only' : 'all models'}`,
    `ctrl+b sort: ${picker.benchmarkSort === 'none' ? 'off' : picker.benchmarkSort}`,
    `ctrl+g by: ${picker.groupBy}`,
  ].join('  ');
}

/** The price tier a row shows (`free`, `paid`, `subscription`); empty when nothing says. */
export function modelWorkspaceTier(model: ModelDefinition): string {
  const tier = modelPriceTier(model);
  return tier === 'unknown' ? '' : MODEL_PRICE_TIER_WORDS[tier];
}

/** How old a provider's model list is, in words: `list read 3 min ago`, `list from the shared catalog`. */
export function modelWorkspaceListAge(reading: { readonly source: string; readonly listedAt?: number | undefined; readonly error?: string | undefined } | undefined, now: number): string | undefined {
  if (!reading) return undefined;
  if (reading.listedAt === undefined) return reading.source === 'catalog' ? 'list from the shared catalog' : undefined;
  const minutes = Math.max(0, Math.round((now - reading.listedAt) / 60_000));
  const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} days ago`;
  return `list read ${age}${reading.error ? ' (the last reading failed)' : ''}`;
}

function formatContextShort(value: number | undefined): string {
  if (!value) return '-';
  return abbreviateCount(value, { rounding: 'round', decimals: 0 });
}

function servesTarget(info: ModelPickerTargetInfo | null, model: ModelDefinition): boolean {
  if (!info || !info.enabled) return false;
  return info.model === model.registryKey || (info.model === model.id && (!info.provider || info.provider === model.provider));
}

function capabilityWords(model: ModelDefinition): string[] {
  const caps = model.capabilities ?? {};
  return [caps.toolCalling ? 'tools' : '', caps.multimodal ? 'vision' : '', caps.reasoning ? 'reasoning' : '', caps.codeEditing ? 'code' : ''].filter(Boolean);
}

function detailRow(canvas: ModalFrame['canvas'], p: KitInset, y: number, key: string, value: string, fg?: string): number {
  const t = activeTokens();
  if (y > p.bottom) return y;
  insetPut(canvas, p, p.l, y, key, { fg: t.textMuted });
  return insetWrap(canvas, p, p.l + 12, y, value, { fg: fg ?? t.text });
}

export interface ModelWorkspaceDetailOptions {
  /** Lines a product adds above the facts (the Agent's local-only header, a hardware fit). */
  readonly lead?: readonly { readonly text: string; readonly fg?: string | undefined }[] | undefined;
  /** Lines after the facts (the Agent's hardware fit). */
  readonly extra?: readonly { readonly text: string; readonly fg?: string | undefined }[] | undefined;
  /** How old the selected model's provider list is (modelWorkspaceListAge). */
  readonly listAge?: string | undefined;
}

/**
 * The selected model in the detail pane, key and value rows: provider, kind
 * (only when the catalog does not describe it, said plainly), price tier,
 * which targets it serves, status, sign-in, health, meters for context and
 * benchmark quality, cost, capability pills, description. Returns the next row.
 */
export function drawModelWorkspaceDetail(f: ModalFrame, picker: ModelPickerModal, p: KitInset, options: ModelWorkspaceDetailOptions = {}): number {
  const t = activeTokens();
  const c = f.canvas;
  const model = picker.getSelected();
  let y = p.top;
  for (const line of options.lead ?? []) y = insetWrap(c, p, p.l, y, line.text, { fg: line.fg ?? t.textMuted });
  if (options.lead && options.lead.length > 0) y++;
  if (!model) return insetWrap(c, p, p.l, y, 'Nothing is selected.', { fg: t.textMuted });
  y = insetWrap(c, p, p.l, y, model.displayName || model.id, { fg: t.text, bold: true });
  y = insetWrap(c, p, p.l, y, modelWorkspaceKey(model), { fg: t.textFaint });
  y++;
  const serves = picker.targetInfos.filter((info) => servesTarget(info, model)).map((info) => modelPickerTargetLabel(info.target));
  const configured = picker.configuredProviders.has(model.provider);
  y = detailRow(c, p, y, 'Provider', model.provider);
  if (picker.textWork(model) === 'unknown') y = detailRow(c, p, y, 'Kind', MODEL_WORKSPACE_UNKNOWN_KIND_DETAIL, t.textMuted);
  const tier = modelWorkspaceTier(model);
  if (tier) y = detailRow(c, p, y, 'Price', tier, tier === 'free' ? t.success : undefined);
  if (options.listAge) y = detailRow(c, p, y, 'List', options.listAge, t.textMuted);
  if (serves.length > 0) y = detailRow(c, p, y, 'Serves', serves.join(' · '));
  const target = picker.getSelectedTargetInfo();
  if (target && !servesTarget(target, model)) y = detailRow(c, p, y, 'Now', `${modelPickerTargetLabel(target.target)}: ${modelWorkspaceTargetSummary(target, true)}`);
  y = detailRow(c, p, y, 'Status', configured ? 'configured' : 'not configured', configured ? t.success : t.warning);
  const signIn = modelWorkspaceSignIn(picker.configuredViaMap.get(model.provider));
  if (configured && signIn) y = detailRow(c, p, y, 'Sign-in', signIn);
  const unreachable = picker.unreachableProviders.get(model.provider);
  if (unreachable !== undefined) y = detailRow(c, p, y, 'Health', `unreachable: ${unreachable}`, t.warning);
  if (picker.isPinned(model)) y = detailRow(c, p, y, 'Pinned', 'yes');
  y++;
  if (model.contextWindow && y <= p.bottom) {
    insetPut(c, p, p.l, y, 'Context', { fg: t.textMuted });
    const end = meter(c, p.l + 12, y, Math.min(1, model.contextWindow / 1_000_000), t.brand, p.bg);
    insetPut(c, p, end + 2, y++, formatContextShort(model.contextWindow), { fg: t.textFaint });
  }
  const score = picker.benchmarkScore(model);
  if (score !== null && y <= p.bottom) {
    insetPut(c, p, p.l, y, 'Quality', { fg: t.textMuted });
    const end = meter(c, p.l + 12, y, score, t.success, p.bg);
    insetPut(c, p, end + 2, y++, score.toFixed(2), { fg: t.textFaint });
  }
  if (model.pricing && y <= p.bottom) y = detailRow(c, p, y, 'Cost', `$${model.pricing.input} in · $${model.pricing.output} out per 1M tokens`);
  const caps = capabilityWords(model);
  if (caps.length > 0 && y <= p.bottom) {
    let cx = p.l;
    for (const cap of caps) {
      if (cx + cap.length + 2 > p.r + 1) break;
      cx = c.put(cx, y, ` ${cap} `, { fg: t.text, bg: t.border }) + 1;
    }
    y += 2;
  }
  if (model.description && y <= p.bottom) y = insetWrap(c, p, p.l, y, model.description, { fg: t.textMuted }) + 1;
  for (const line of options.extra ?? []) if (y <= p.bottom) y = insetWrap(c, p, p.l, y, line.text, { fg: line.fg ?? t.textMuted });
  if (picker.isLocalModel(model) && y <= p.bottom) y = insetWrap(c, p, p.l, y, 'Local model: space sets a context cap.', { fg: t.textFaint }) + 1;
  return y;
}
export function modelWorkspaceKey(model: ModelDefinition): string {
  return model.registryKey ?? `${model.provider}:${model.id}`;
}
export function modelWorkspaceRoute(provider: string, model: string): string {
  if (!provider && !model) return '(not set)';
  if (!provider) return model;
  if (!model) return provider;
  return model.startsWith(`${provider}:`) ? model : `${provider}:${model}`;
}
/**
 * Which sign-in a provider's requests use, in words, from how it is set up
 * (ProviderConfiguredStatus.configuredVia): a subscription sign-in comes first
 * when it is set up (OpenAI: then the API key), else the key.
 */
export function modelWorkspaceSignIn(via: string | undefined): string | undefined {
  if (via === 'subscription') return 'subscription sign-in first (then an API key, when one is set)';
  if (via === 'env') return 'API key from the environment';
  if (via === 'secrets') return 'API key from the secret store';
  if (via === 'anonymous') return 'no key needed';
  return undefined;
}
export function modelWorkspaceTargetSummary(
  info: {
    readonly enabled: boolean;
    readonly inherited: boolean;
    readonly provider: string;
    readonly model: string;
    readonly configuredNote?: string | undefined;
  },
  includeConfiguredNote = false,
): string {
  if (!info.enabled) return 'disabled';
  if (includeConfiguredNote && info.configuredNote) return info.configuredNote;
  const route = modelWorkspaceRoute(info.provider, info.model);
  return info.inherited ? `inherits ${route}` : route;
}
export function modelWorkspaceProviderRows(
  picker: {
    readonly models: readonly { readonly provider: string }[];
    readonly configuredProviders: ReadonlySet<string>;
    readonly configuredViaMap: ReadonlyMap<string, string | undefined>;
    readonly selectedIndex: number;
    getFilteredProviders(): string[];
  },
  policy: {
    readonly unconfiguredColor: string;
    readonly groupedItems?:
      | readonly { readonly id: string; readonly label: string; readonly isGroupHeader?: boolean | undefined }[]
      | undefined;
  },
): KitRow[] {
  const t = activeTokens();
  const counts = new Map<string, number>();
  for (const model of picker.models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  const providers = picker.getFilteredProviders();
  const items = policy.groupedItems ?? providers.map((id) => ({ id, label: id, isGroupHeader: false }));
  const rows: KitRow[] = [];
  let index = 0;
  for (const item of items) {
    if (item.isGroupHeader) {
      rows.push({ header: item.label });
      continue;
    }
    const provider = item.id;
    const configured = picker.configuredProviders.has(provider);
    const selected = policy.groupedItems ? providers.indexOf(provider) : index;
    rows.push({
      label: provider,
      desc: picker.configuredViaMap.get(provider) ?? (configured ? 'configured' : 'not configured'),
      right: `${counts.get(provider) ?? 0} models`,
      mark: configured ? '●' : '○',
      markFg: configured ? t.success : policy.unconfiguredColor,
      selected: (selected >= 0 ? selected : index) === picker.selectedIndex,
    });
    index++;
  }
  return rows;
}

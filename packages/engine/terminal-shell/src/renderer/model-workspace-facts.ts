import type { ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import type { KitRow } from './surface-kit-list.js';
import { activeTokens } from './theme.js';
export function modelWorkspaceKey(model: ModelDefinition): string {
  return model.registryKey ?? `${model.provider}:${model.id}`;
}
export function modelWorkspaceRoute(provider: string, model: string): string {
  if (!provider && !model) return '(not set)';
  if (!provider) return model;
  if (!model) return provider;
  return model.startsWith(`${provider}:`) ? model : `${provider}:${model}`;
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

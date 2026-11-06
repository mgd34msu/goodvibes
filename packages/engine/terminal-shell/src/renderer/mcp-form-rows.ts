import { activeTokens } from './theme.js';
import type { KitRow } from './surface-kit-list.js';
import type { McpWorkspaceFormField } from '../mcp-workspace-model.js';
export function formRows(workspace: {
  readonly formIndex: number;
  readonly formFields: readonly McpWorkspaceFormField<string>[];
}): KitRow[] {
  const t = activeTokens();
  return workspace.formFields.map((field, index) => {
    const selected = index === workspace.formIndex;
    const isAction = field.id === 'save' || field.id === 'cancel';
    const value = isAction ? undefined : field.value.length > 0 ? field.value : '(empty)';
    return {
      label: field.label,
      desc: value !== undefined && selected && field.editable ? `${field.value}▏` : value,
      right: !isAction && !field.editable ? '←→' : undefined,
      labelFg: field.id === 'save' ? t.success : field.id === 'cancel' ? t.warning : undefined,
      bold: isAction,
      selected,
    };
  });
}

export interface McpTrustRowEntry {
  readonly name: string;
  readonly allowedPaths: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly trustMode: string;
  readonly connected: boolean;
  readonly role: string;
}
export function mcpTrustRows(
  items: readonly McpTrustRowEntry[],
  selected: number,
  focused: boolean,
  editing: boolean,
  buffer: string,
): KitRow[] {
  const t = activeTokens();
  return items.map((entry, i) => {
    const scope =
      entry.allowedPaths.length > 0
        ? entry.allowedPaths.join(', ')
        : entry.allowedHosts.length > 0
          ? entry.allowedHosts.join(', ')
          : 'no scope';
    const trust = i === selected && editing ? `${buffer}▏` : entry.trustMode;
    return {
      label: entry.name,
      desc: `${entry.role} · ${scope}`,
      right: trust,
      mark: entry.connected ? '●' : '○',
      markFg: entry.connected ? t.success : t.textFaint,
      selected: i === selected && focused,
      current: i === selected && !focused,
    };
  });
}

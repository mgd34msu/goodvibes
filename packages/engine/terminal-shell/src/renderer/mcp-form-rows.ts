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

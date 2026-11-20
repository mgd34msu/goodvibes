import type { AgentWorkspaceCategory } from './agent-workspace-types.ts';
import { workspaceActionDetail, workspaceActionLabel, workspaceActionReadsOnly, type WorkspaceActionTarget } from './workspace-actions.ts';

type AgentWorkspaceAction = AgentWorkspaceCategory['actions'][number];

export function settingAction(options: {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly key: string;
  readonly value?: string;
  readonly visibleWhenKey?: string;
  readonly visibleWhenValue?: string | boolean | number;
}): AgentWorkspaceAction {
  return {
    id: options.id,
    label: options.label,
    detail: options.detail,
    kind: 'setting',
    safety: 'safe',
    settingKey: options.key,
    ...(options.value !== undefined ? { settingValueHint: options.value } : {}),
    ...(options.visibleWhenKey !== undefined ? { visibleWhenSettingKey: options.visibleWhenKey } : {}),
    ...(options.visibleWhenValue !== undefined ? { visibleWhenSettingValue: options.visibleWhenValue } : {}),
  };
}

/**
 * A row that runs a described command's action: `act` is "<command> <action>"
 * (or just "<command>" for the command's own list), `values` what the row
 * fills in. Its name, what it does and whether it only reads are read from the
 * action's description each time they are shown (the description is
 * registered when the commands are, after this table is built).
 */
export function actRow(id: string, act: string, values?: Readonly<Record<string, string>>): AgentWorkspaceAction {
  const [command = '', ...rest] = act.trim().split(/\s+/);
  const target: WorkspaceActionTarget = { command, ...(rest.length > 0 ? { action: rest.join(' ') } : {}), ...(values ? { values } : {}) };
  const row = { id, kind: 'act' as const, act: target } as const;
  return Object.defineProperties(row, {
    label: { get: () => workspaceActionLabel(target), enumerable: true },
    detail: { get: () => workspaceActionDetail(target), enumerable: true },
    safety: { get: () => workspaceActionReadsOnly(target) ? 'read-only' : 'safe', enumerable: true },
  }) as unknown as AgentWorkspaceAction;
}

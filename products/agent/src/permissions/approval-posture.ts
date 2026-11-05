import { hasActiveExecutionMode, readExecutionMode } from './execution-mode.ts';
import { type ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { effectivePermissionMode, presetForMode, type GatePresetName } from '@goodvibes-jev/engine/sdk/platform/gate';

export type ApprovalPostureKind = GatePresetName | 'unavailable';

export interface ApprovalPostureInput {
  readonly autoApprove: boolean;
  readonly mode: unknown;
  /** Retained for callers reading older configuration; execution modes own policy. */
  readonly customTools?: Readonly<Record<string, unknown>>;
}

/** Configuration display only. The shared preset owns execution behavior. */
export interface ApprovalPosture {
  readonly kind: ApprovalPostureKind;
  readonly mode: GatePresetName | 'unavailable';
  readonly autoApprove: boolean;
  readonly automaticApprovals: boolean;
  readonly bypassesPrompts: boolean;
  readonly label: string;
  readonly detail: string;
}

export function computeApprovalPosture(input: ApprovalPostureInput): ApprovalPosture {
  const preset = presetForMode(effectivePermissionMode(input.mode, input.autoApprove));
  return {
    kind: preset.name,
    mode: preset.name,
    autoApprove: input.autoApprove,
    automaticApprovals: preset.name === 'yolo',
    bypassesPrompts: preset.name === 'yolo' || preset.name === 'safe-jev',
    label: preset.label,
    detail: preset.summary,
  };
}

export function readApprovalPostureFromConfig(configManager: Pick<ConfigManager, 'get'>): ApprovalPosture {
  const mode = readExecutionMode(configManager);
  if (mode === undefined) return {
    kind: 'unavailable', mode: 'unavailable', autoApprove: false,
    automaticApprovals: false, bypassesPrompts: false,
    label: 'Execution mode unavailable', detail: 'The active hosted session has not supplied a current execution mode.',
  };
  return computeApprovalPosture({ autoApprove: !hasActiveExecutionMode(configManager) && configManager.get('behavior.autoApprove') === true, mode });
}

/** Shared execution modes for the engine and every product surface. */
import type { PermissionMode } from '../config/schema-types-permissions.js';
import type { Stakes } from '@goodvibes-jev/judgment';
import type { GateRiskFamily } from './batteries/risk-family.js';

/** What the gate does with a call at a given stakes level. */
export type GateAction = 'allow' | 'ask' | 'deny';

/** The preset names, as the mode pill shows them. */
export type GatePresetName = 'safe-owner' | 'safe-jev' | 'yolo' | 'plan';

export type { Stakes as GateStakes } from '@goodvibes-jev/judgment';

/** Stakes levels from lowest to highest; the index is the level number. */
export const GATE_STAKES: readonly Stakes[] = ['low', 'medium', 'high', 'critical'];

export interface GatePreset {
  readonly name: GatePresetName;
  /** The `permissions.mode` value that selects this preset. */
  readonly mode: PermissionMode;
  /** One line for the presets sheet and the docs. */
  readonly summary: string;
  /** The action per stakes level. */
  readonly stakes: Readonly<Record<Stakes, GateAction>>;
  /**
   * Plan preset: a call Jev reads as changing anything or reaching outside the
   * machine is denied with the plan-mode denial, whatever its stakes.
   */
  readonly readOnly: boolean;

}

/** A gate preset with its shared human-readable picker label. */
export interface GatePresetDefinition extends GatePreset {
  readonly label: string;
}

/** Safe modes permit ordinary work; only consequential risk needs a decision. */
export const GATE_PRESETS: Readonly<Record<GatePresetName, GatePresetDefinition>> = {
  'safe-owner': {
    name: 'safe-owner', label: 'Safe — owner', mode: 'safe-owner',
    summary: 'Ordinary actions run automatically; dangerous actions ask the owner.',
    stakes: { low: 'allow', medium: 'allow', high: 'allow', critical: 'ask' },
    readOnly: false,
  },
  'safe-jev': {
    name: 'safe-jev', label: 'Safe — Jev', mode: 'safe-jev',
    summary: 'Jev stands in for the owner, allowing justified actions and refusing genuinely harmful ones.',
    stakes: { low: 'allow', medium: 'allow', high: 'allow', critical: 'ask' },
    readOnly: false,
  },
  yolo: {
    name: 'yolo', label: 'YOLO', mode: 'yolo',
    summary: 'Runs authorized actions without general safety decisions; host containment, secret storage and payment rules still apply.',
    stakes: { low: 'allow', medium: 'allow', high: 'allow', critical: 'allow' },
    readOnly: false,
  },
  plan: {
    name: 'plan', label: 'Plan', mode: 'plan',
    summary: 'Planning only; execution and state changes are held until an execution mode is selected.',
    stakes: { low: 'allow', medium: 'allow', high: 'allow', critical: 'ask' },
    readOnly: true,
  },
};

/** Plan is a separate non-executing posture, outside the execution-mode cycle. */
export const SESSION_GATE_PRESET_NAMES = ['safe-owner', 'safe-jev', 'yolo', 'plan'] as const satisfies readonly GatePresetName[];
export type SettableGatePresetName = (typeof SESSION_GATE_PRESET_NAMES)[number];

/** Exact canonical mode membership; unknown wire values remain invalid. */
export function isGatePresetName(value: string): value is GatePresetName {
  return Object.hasOwn(GATE_PRESETS, value);
}

/** Whether sessions.permissionMode.set accepts this preset name. */
export function isSettableGatePresetName(value: string): value is SettableGatePresetName {
  return SESSION_GATE_PRESET_NAMES.some((name) => name === value);
}

/** A reported session preset's label, preserving unknown and absent wire values. */
export function gatePresetLabel(name: string): string {
  return isGatePresetName(name) ? GATE_PRESETS[name].label : (name || 'Unknown');
}

/** Decode saved legacy settings into the single current mode vocabulary. */
export function parsePermissionMode(mode: unknown): GatePresetName | undefined {
  switch (mode) {
    case 'safe-owner': case 'safe-jev': case 'yolo': case 'plan': return mode;
    case 'auto': return 'safe-jev';
    case 'allow-all': return 'yolo';
    case 'prompt': case 'normal': case 'accept-edits': case 'custom': return 'safe-owner';
    default: return undefined;
  }
}

export function normalizePermissionMode(mode: unknown): GatePresetName {
  return parsePermissionMode(mode) ?? 'safe-owner';
}

/** The old auto-approve switch is a saved alias for YOLO. */
export function effectivePermissionMode(mode: unknown, autoApprove = false): GatePresetName {
  return autoApprove ? 'yolo' : normalizePermissionMode(mode);
}

export function presetForMode(mode: unknown): GatePresetDefinition {
  return GATE_PRESETS[normalizePermissionMode(mode)];
}

/** The stakes level one higher than `stakes`, or critical. */
export function raiseStakes(stakes: Stakes): Stakes {
  return GATE_STAKES[Math.min(GATE_STAKES.length - 1, GATE_STAKES.indexOf(stakes) + 1)]!;
}

/** The higher of two stakes levels. */
export function maxStakes(a: Stakes, b: Stakes): Stakes {
  return GATE_STAKES.indexOf(a) >= GATE_STAKES.indexOf(b) ? a : b;
}

/** The facts a preset decides on: the call's stakes, its risk family, and whether it changes anything. */
export interface PresetInput {
  readonly stakes: Stakes;
  readonly family: GateRiskFamily;
  /** Jev read the call as changing state or reaching outside the machine (uncertain counts as yes). */
  readonly changesState: boolean;
}

/** What a preset decides for one read call, and why. */
export interface PresetDecision {
  readonly action: GateAction;
  readonly reason: 'stakes' | 'plan-read-only';
}

/** Applies a preset's row to one read call. */
export function decideByPreset(preset: GatePreset, input: PresetInput): PresetDecision {
  if (preset.readOnly && input.changesState) return { action: 'deny', reason: 'plan-read-only' };
  return { action: preset.stakes[input.stakes], reason: 'stakes' };
}

// ── The mode vocabulary shared by every surface (hoisted from the TUI) ───────

/** The config `permissions.mode` values, exactly as the schema defines them. */
export type PermissionModeValue = PermissionMode;

/** The three execution modes, shared by keyboard and graphical controls. */
export const PERMISSION_MODE_CYCLE = ['safe-owner', 'safe-jev', 'yolo'] as const satisfies readonly PermissionModeValue[];

/** User-facing label for a mode value: the preset name the pill shows. */
export function permissionModeLabel(mode: PermissionModeValue | string | undefined): GatePresetName {
  return presetForMode(mode).name;
}

/** Presentation tone shared by every mode control. */
export type PermissionModeTone = 'neutral' | 'info' | 'caution';

export function permissionModeTone(mode: PermissionModeValue | string | undefined): PermissionModeTone {
  switch (normalizePermissionMode(mode)) {
    case 'plan': return 'info';
    case 'safe-jev': case 'yolo': return 'caution';
    default: return 'neutral';
  }
}

/** Cycle execution modes; unknown values and the planning posture enter safe-owner. */
export function nextPermissionMode(current: PermissionModeValue | string | undefined): PermissionModeValue {
  const idx = PERMISSION_MODE_CYCLE.findIndex(mode => mode === parsePermissionMode(current));
  if (idx < 0) return PERMISSION_MODE_CYCLE[0]!;
  return PERMISSION_MODE_CYCLE[(idx + 1) % PERMISSION_MODE_CYCLE.length]!;
}

/** True when the value selects the plan preset. */
export function isPlanMode(mode: PermissionModeValue | string | undefined): boolean {
  return mode === 'plan';
}

/** Enter the planning posture, or return to safe-owner from planning. */
export function togglePlanMode(current: PermissionModeValue | string | undefined): PermissionModeValue {
  return isPlanMode(current) ? 'safe-owner' : 'plan';
}

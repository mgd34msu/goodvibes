/** Shared execution modes for the engine and every product surface. */
import { decisionModelSet, type DecisionModelSettings } from '../config/decision-model-set.js';
import type { PermissionMode } from '../config/schema-types-permissions.js';
import type { Stakes } from '@goodvibes/judgment';
import type { GateRiskFamily } from './batteries/risk-family.js';

/** What the gate does with a call at a given stakes level. */
export type GateAction = 'allow' | 'ask' | 'deny';

/** The preset names, as the mode pill shows them. */
export type GatePresetName = 'ask-me' | 'jev-decides' | 'just-vibes' | 'yolo' | 'plan';

export type { Stakes as GateStakes } from '@goodvibes/judgment';

/** Stakes levels from lowest to highest; the index is the level number. */
export const GATE_STAKES: readonly Stakes[] = ['low', 'medium', 'high', 'critical'];

export interface GatePreset {
  readonly name: GatePresetName;
  /** The `permissions.mode` value that selects this preset. */
  readonly mode: PermissionMode;
  /** What the mode does, in plain sentences, for the presets sheet, the mode chip and the docs. */
  readonly summary: string;
  /**
   * The summary in one short line, for the notice when the mode changes
   * (Shift+Tab), the Agent's mode row and the terminal's mode picker:
   * "asks before commands and changes outside this folder".
   */
  readonly short: string;
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

/** Every mode permits ordinary work; they differ in who decides the rest. */
export const GATE_PRESETS: Readonly<Record<GatePresetName, GatePresetDefinition>> = {
  'ask-me': {
    name: 'ask-me', label: 'Ask me', mode: 'ask-me',
    summary: 'GoodVibes asks you before anything risky. With a decision model, Jev reads each action and you are asked about what can\'t be undone, weakens a safety setting, hides what it does or sends secrets out. Without one, you are asked before every command and every file change outside this folder, unless a per-tool setting allows it.',
    short: 'asks you before anything risky; without a decision model, before every command and change outside this folder',
    stakes: { low: 'allow', medium: 'allow', high: 'allow', critical: 'ask' },
    readOnly: false,
  },
  'jev-decides': {
    name: 'jev-decides', label: 'Jev decides', mode: 'jev-decides',
    summary: 'Jev, the decision model, decides what is safe to run and refuses what is harmful; you are asked only about decisions that are yours, such as destroying data or weakening a safety setting. Without a working decision model, GoodVibes asks you instead, as Ask me does.',
    short: 'the decision model decides; you are asked only about destroying data and weakening safety',
    stakes: { low: 'allow', medium: 'allow', high: 'allow', critical: 'ask' },
    readOnly: false,
  },
  'just-vibes': {
    name: 'just-vibes', label: 'Just vibes', mode: 'just-vibes',
    summary: 'GoodVibes keeps working without interrupting you: Jev decides what it can, and anything that needs you is held and listed at the end of the run. Without a working decision model, everything that needs a decision is held.',
    short: 'nothing interrupts you; what needs you is held and listed at the end',
    stakes: { low: 'allow', medium: 'allow', high: 'allow', critical: 'ask' },
    readOnly: false,
  },
  yolo: {
    name: 'yolo', label: 'YOLO', mode: 'yolo',
    summary: 'GoodVibes runs everything without asking; it still keeps to the sandbox, secret storage and payment limits.',
    short: 'runs everything without asking, inside the sandbox and payment limits',
    stakes: { low: 'allow', medium: 'allow', high: 'allow', critical: 'allow' },
    readOnly: false,
  },
  plan: {
    name: 'plan', label: 'Plan', mode: 'plan',
    summary: 'Planning only: GoodVibes reads and plans but changes nothing. Leave plan mode to carry out the plan.',
    short: 'reads and plans, changes nothing',
    stakes: { low: 'allow', medium: 'allow', high: 'allow', critical: 'ask' },
    readOnly: true,
  },
};

/** Plan is a separate non-executing posture, outside the execution-mode cycle. */
export const SESSION_GATE_PRESET_NAMES = ['ask-me', 'jev-decides', 'just-vibes', 'yolo', 'plan'] as const satisfies readonly GatePresetName[];
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
    case 'ask-me': case 'jev-decides': case 'just-vibes': case 'yolo': case 'plan': return mode;
    case 'safe-owner': return 'ask-me';
    case 'safe-jev': case 'auto': return 'jev-decides';
    case 'just-work': return 'just-vibes';
    case 'allow-all': return 'yolo';
    case 'prompt': case 'normal': case 'accept-edits': case 'custom': return 'ask-me';
    default: return undefined;
  }
}

/**
 * What changed for an owner whose saved `permissions.mode` is a retired value.
 *
 * None of the retired values asks before ordinary work any more: they all run as
 * ask-me, where only critical actions ask. A saved `prompt` that used to ask on
 * every change is loosened by that, so a surface that reads the saved mode says so
 * instead of changing the posture silently. Undefined for a current or unknown value.
 */
export function retiredPermissionModeNotice(mode: unknown): string | undefined {
  if (mode !== 'prompt' && mode !== 'normal' && mode !== 'accept-edits' && mode !== 'custom') return undefined;
  return `permissions.mode "${mode}" is retired and now runs as ask-me: with a working decision model ordinary actions run without asking and only critical actions ask; without one, every action asks except a read inside the workspace and a change to files inside it that can be undone. `
    + 'To be asked less, choose jev-decides, just-vibes or yolo; for read-only planning choose plan; to block one tool, set permissions.tools.<tool> to deny.';
}

export function normalizePermissionMode(mode: unknown): GatePresetName {
  return parsePermissionMode(mode) ?? 'ask-me';
}

export type { DecisionModelSettings } from '../config/decision-model-set.js';

/**
 * Whether a decision model is there to answer, from facts the program holds:
 * one is set (config/decision-model-set.ts).
 * A key in the secret store is trusted to be there; a failed request then
 * takes the judgment's fallback and is reported.
 */
export function decisionModelReady(settings: DecisionModelSettings, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return decisionModelSet(settings, env);
}

/**
 * The mode in force. The old auto-approve switch is a saved alias for YOLO;
 * Jev cannot decide without a working decision model, so jev-decides asks the
 * owner instead (just-vibes keeps going and holds those items for the end).
 */
export function effectivePermissionMode(mode: unknown, autoApprove = false, decisionModelWorks = true): GatePresetName {
  if (autoApprove) return 'yolo';
  const parsed = normalizePermissionMode(mode);
  return parsed === 'jev-decides' && !decisionModelWorks ? 'ask-me' : parsed;
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

/** The execution modes, in the order keyboard and graphical controls cycle them. */
export const PERMISSION_MODE_CYCLE = ['ask-me', 'jev-decides', 'just-vibes', 'yolo'] as const satisfies readonly PermissionModeValue[];

/** User-facing label for a mode value: the preset name the pill shows. */
export function permissionModeLabel(mode: PermissionModeValue | string | undefined): GatePresetName {
  return presetForMode(mode).name;
}

/** Presentation tone shared by every mode control. */
export type PermissionModeTone = 'neutral' | 'info' | 'caution';

export function permissionModeTone(mode: PermissionModeValue | string | undefined): PermissionModeTone {
  switch (normalizePermissionMode(mode)) {
    case 'plan': return 'info';
    case 'jev-decides': case 'just-vibes': case 'yolo': return 'caution';
    default: return 'neutral';
  }
}

/** Cycle execution modes; unknown values and the planning posture enter ask-me. */
export function nextPermissionMode(current: PermissionModeValue | string | undefined): PermissionModeValue {
  const idx = PERMISSION_MODE_CYCLE.findIndex(mode => mode === parsePermissionMode(current));
  if (idx < 0) return PERMISSION_MODE_CYCLE[0]!;
  return PERMISSION_MODE_CYCLE[(idx + 1) % PERMISSION_MODE_CYCLE.length]!;
}

/** True when the value selects the plan preset. */
export function isPlanMode(mode: PermissionModeValue | string | undefined): boolean {
  return mode === 'plan';
}

/** Enter the planning posture, or return to ask-me from planning. */
export function togglePlanMode(current: PermissionModeValue | string | undefined): PermissionModeValue {
  return isPlanMode(current) ? 'ask-me' : 'plan';
}

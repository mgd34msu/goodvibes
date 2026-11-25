/**
 * GateEvent, the discriminated union of the gate's events: the one path every
 * side effect takes (platform/gate). A call is requested before any owner
 * prompt, and its decision (the boundary, the stakes reading, the active
 * preset, an owner rule or the owner's answer) is emitted once it settles,
 * carrying the reading's classification and risk level.
 */

export type GateEvent =
  /** A tool call has reached the gate. */
  | {
      type: 'GATE_REQUESTED';
      callId: string;
      tool: string;
      args: Record<string, unknown>;
      category: string;
      classification?: string | undefined;
      riskLevel?: string | undefined;
      summary?: string | undefined;
      reasons?: readonly string[] | undefined;
    }
  /**
   * The active preset changed (normal, accept-edits, plan, auto, custom).
   * Emitted whenever the `permissions.mode` setting changes so surfaces can
   * render a live preset pill without polling. `mode` and `previousMode` are
   * the setting's values ('prompt' | 'allow-all' | 'custom' | 'plan' |
   * 'accept-edits'); `preset` and `previousPreset` are the preset names.
   */
  | { type: 'PRESET_CHANGED'; preset: string; previousPreset: string; mode: string; previousMode: string }
  /** The gate's final decision for the call. */
  | {
      type: 'DECISION_EMITTED';
      callId: string;
      tool: string;
      /** The category the gate settled on (the built-in tool's, or the one Jev read). */
      category: string;
      approved: boolean;
      source: string;
      sourceLayer?: string | undefined;
      persisted?: boolean | undefined;
      reasonCode?: string | undefined;
      classification?: string | undefined;
      riskLevel?: string | undefined;
      summary?: string | undefined;
      /** Why: when Jev decided the call, its reason; on a refusal the gate explained, that explanation. */
      reason?: string | undefined;
    };

/** All gate event type literals as a union. */
export type GateEventType = GateEvent['type'];

/** Every gate event type, for validators and consumers that enumerate the domain. */
export const GATE_EVENT_TYPES: readonly GateEventType[] = [
  'GATE_REQUESTED',
  'PRESET_CHANGED',
  'DECISION_EMITTED',
];

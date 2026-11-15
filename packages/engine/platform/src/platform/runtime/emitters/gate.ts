/**
 * Gate emitters, typed emission wrappers for the GateEvent domain.
 */
import type { GateEvent } from '../../../events/gate.js';
import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from './index.js';

type Data<T extends GateEvent['type']> = Omit<Extract<GateEvent, { type: T }>, 'type'>;

function emitGate<T extends GateEvent['type']>(bus: RuntimeEventBus, ctx: EmitterContext, type: T, data: Data<T>): void {
  bus.emit('gate', createEventEnvelope(type, { type, ...data } as Extract<GateEvent, { type: T }>, ctx));
}

/** Emit GATE_REQUESTED when a tool call reaches the gate. */
export function emitGateRequested(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'GATE_REQUESTED'>): void {
  emitGate(bus, ctx, 'GATE_REQUESTED', data);
}

/** Emit BOUNDARY_CHECKED after the deterministic boundary runs. */
export function emitBoundaryChecked(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'BOUNDARY_CHECKED'>): void {
  emitGate(bus, ctx, 'BOUNDARY_CHECKED', data);
}

/** Emit STAKES_READ after Jev reads a call's stakes. */
export function emitStakesRead(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'STAKES_READ'>): void {
  emitGate(bus, ctx, 'STAKES_READ', data);
}

/** Emit PRESET_EVALUATED after the active preset maps the stakes to an action. */
export function emitPresetEvaluated(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'PRESET_EVALUATED'>): void {
  emitGate(bus, ctx, 'PRESET_EVALUATED', data);
}

/** Emit PRESET_CHANGED when the active preset changes. */
export function emitPresetChanged(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'PRESET_CHANGED'>): void {
  emitGate(bus, ctx, 'PRESET_CHANGED', data);
}

/** Emit DECISION_EMITTED when the gate's final decision is made. */
export function emitGateDecision(bus: RuntimeEventBus, ctx: EmitterContext, data: Data<'DECISION_EMITTED'>): void {
  emitGate(bus, ctx, 'DECISION_EMITTED', data);
}

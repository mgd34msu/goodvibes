/**
 * UI emitters, typed wrappers for the UIEvent domain.
 */

import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { GoodVibesUIEvent as UIEvent } from '../../../events/ui.js';
import type { EmitterContext } from './index.js';

function uiEvent<T extends UIEvent['type']>(
  type: T,
  data: Omit<Extract<UIEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<UIEvent, { type: T }>> {
  return createEventEnvelope(type, { type, ...data } as Extract<UIEvent, { type: T }>, ctx);
}

export function emitUiPanelOpen(bus: Pick<RuntimeEventBus, 'emit'>, ctx: EmitterContext, data: { panelId: string }): void {
  bus.emit('ui', uiEvent('UI_PANEL_OPEN', data, ctx));
}

export function emitUiPanelClose(bus: Pick<RuntimeEventBus, 'emit'>, ctx: EmitterContext, data: { panelId: string }): void {
  bus.emit('ui', uiEvent('UI_PANEL_CLOSE', data, ctx));
}

export function emitUiPanelFocus(bus: Pick<RuntimeEventBus, 'emit'>, ctx: EmitterContext, data: { panelId: string }): void {
  bus.emit('ui', uiEvent('UI_PANEL_FOCUS', data, ctx));
}

export function emitUiViewChanged(bus: Pick<RuntimeEventBus, 'emit'>, ctx: EmitterContext, data: { from: string; to: string }): void {
  bus.emit('ui', uiEvent('UI_VIEW_CHANGED', data, ctx));
}

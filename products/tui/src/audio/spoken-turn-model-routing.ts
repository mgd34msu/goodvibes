import { createSpokenTurnInputOptions as platformSpokenTurnInputOptions } from '@goodvibes/engine/platform/platform/voice';
export { attachSpokenTurnModelRouting, resolveSpokenTurnModelOverride, type SpokenTurnModelRoutingOptions } from '@goodvibes/engine/platform/platform/voice';
export const createSpokenTurnInputOptions = () => platformSpokenTurnInputOptions('tui');

import { createSpokenTurnInputOptions as platformSpokenTurnInputOptions } from '@goodvibes-jev/engine/platform/platform/voice';
export { attachSpokenTurnModelRouting, resolveSpokenTurnModelOverride, type SpokenTurnModelRoutingOptions } from '@goodvibes-jev/engine/platform/platform/voice';
export const createSpokenTurnInputOptions = () => platformSpokenTurnInputOptions('goodvibes-agent');

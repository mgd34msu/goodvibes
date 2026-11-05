import { createSpokenTurnInputOptions as platformSpokenTurnInputOptions } from '@goodvibes-jev/engine/sdk/platform/voice';
export { attachSpokenTurnModelRouting, resolveSpokenTurnModelOverride, type SpokenTurnModelRoutingOptions } from '@goodvibes-jev/engine/sdk/platform/voice';
export const createSpokenTurnInputOptions = () => platformSpokenTurnInputOptions('goodvibes-agent');

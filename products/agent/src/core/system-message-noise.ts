import { classifyNoise as classify, type NoiseGateDeps } from '@goodvibes/engine/terminal-shell/system-message-noise';
export * from '@goodvibes/engine/terminal-shell/system-message-noise';
export const classifyNoise = (message: string, deps: NoiseGateDeps) => classify(message, deps, true);

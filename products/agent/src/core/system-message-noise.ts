import { classifyNoise as classify, type NoiseGateDeps } from '@goodvibes-jev/engine/terminal-shell/system-message-noise';
export * from '@goodvibes-jev/engine/terminal-shell/system-message-noise';
export const classifyNoise = (message: string, deps: NoiseGateDeps) => classify(message, deps, true);

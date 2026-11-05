import { createSplashLines } from '@goodvibes-jev/engine/terminal-shell/splash-lines';
import { VERSION } from '../version.ts';
export { SPLASH_GRADIENT, type SplashOptions } from '@goodvibes-jev/engine/terminal-shell/splash-lines';
export const getSplashLines = createSplashLines(VERSION, true, 'Ctrl+P commands  /  ? help  /  F2 agents');

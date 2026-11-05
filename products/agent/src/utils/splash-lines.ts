import { createSplashLines } from '@goodvibes-jev/engine/terminal-shell/splash-lines';
import { VERSION } from '../version.ts';
export { SPLASH_GRADIENT, type SplashOptions } from '@goodvibes-jev/engine/terminal-shell/splash-lines';
export const getSplashLines = createSplashLines(VERSION, false, 'start chatting or type /help for commands');

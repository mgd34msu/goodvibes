import { createSplashLines } from '@goodvibes/engine/terminal-shell/splash-lines';
import { VERSION } from '../version.ts';
export { SPLASH_GRADIENT, type SplashOptions } from '@goodvibes/engine/terminal-shell/splash-lines';
export const getSplashLines = createSplashLines(VERSION, false, 'start chatting or type /help for commands');

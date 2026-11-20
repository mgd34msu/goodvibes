import { createSplashLines } from '@goodvibes/engine/terminal-shell/splash-lines';
import { VERSION } from '../version.ts';
export { SPLASH_GRADIENT, type SplashOptions } from '@goodvibes/engine/terminal-shell/splash-lines';
// The palette key is rebindable, so it comes from the live binding the shell
// passes in; `?` and F2 are fixed keys. Ctrl+P is the default binding.
export const getSplashLines = createSplashLines(VERSION, true, (opts) => `${opts.commandPaletteKey ?? 'Ctrl+P'} commands  /  ? help  /  F2 agents`);

import { resolveThrobberActivity as resolve, renderThrobberLine as render, type ThrobberActivityInput, type ThrobberState } from '@goodvibes-jev/engine/terminal-shell/throbber';
import { beadName } from './lane-graph/bead.ts';
export * from '@goodvibes-jev/engine/terminal-shell/throbber';
export const resolveThrobberActivity = (input: ThrobberActivityInput) => resolve(input, beadName);
export const renderThrobberLine = (width: number, state: ThrobberState) => render(width, state, true);

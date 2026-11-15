import { resolveThrobberActivity as resolve, renderThrobberLine as render, type ThrobberActivityInput, type ThrobberState } from '@goodvibes-jev/engine/terminal-shell/throbber';
import { friendlyToolLabel } from './tool-labels.ts';
export * from '@goodvibes-jev/engine/terminal-shell/throbber';
export const resolveThrobberActivity = (input: ThrobberActivityInput) => resolve(input, { toolLabel: friendlyToolLabel });
export const renderThrobberLine = (width: number, state: ThrobberState) => render(width, state, true);

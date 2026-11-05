import { beadName as platformBeadName } from '@goodvibes-jev/engine/terminal-shell/bead';
import { friendlyToolLabel } from '../tool-labels.ts';
export * from '@goodvibes-jev/engine/terminal-shell/bead';
export const beadName = (call: Parameters<typeof platformBeadName>[0]) => platformBeadName(call, friendlyToolLabel);

import { InputHistory as PlatformHistory, type InputHistoryOptions } from '@goodvibes/engine/terminal-shell/input-history';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
export * from '@goodvibes/engine/terminal-shell/input-history';
export class InputHistory extends PlatformHistory {
  constructor(options: InputHistoryOptions) { super({ ...options, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT }); }
}

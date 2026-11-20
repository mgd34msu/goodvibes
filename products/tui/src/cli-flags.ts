import { createCliFlagParser } from '@goodvibes/engine/terminal-shell';
// Compatibility wrapper for older imports. New CLI code lives in src/cli.
export type { GoodVibesCliFlags as CliFlags } from '@goodvibes/engine/terminal-shell';
export {
  applyRuntimeConfigDefault,
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeEndpointFlagOverrides,
  applyRuntimeFeatureFlagOverrides,
  handleGoodVibesCliCommand,
  parseGoodVibesCli,
  renderGoodVibesCommandHelp,
  renderGoodVibesHelp,
  renderGoodVibesVersion,
} from './cli/index.ts';

import { parseGoodVibesCli } from '@goodvibes/engine/terminal-shell';
import type { GoodVibesCliFlags } from '@goodvibes/engine/terminal-shell';

export const parseCliFlags = createCliFlagParser(parseGoodVibesCli);

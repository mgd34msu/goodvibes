import { createCliFlagParser } from '@goodvibes-jev/engine/terminal-shell';
// Compatibility wrapper for older imports. New CLI code lives in src/cli.
export type { GoodVibesCliFlags as CliFlags } from './cli/types.ts';
export {
  applyRuntimeConfigOverrides,
  applyRuntimeConfigValue,
  applyRuntimeCommandEndpointFlagOverrides,
  applyRuntimeEndpointFlagOverrides,
  applyRuntimeFeatureOverrides,
  applyRuntimeUrlOverride,
  handleGoodVibesCliCommand,
  parseGoodVibesCli,
  renderGoodVibesCommandHelp,
  renderGoodVibesHelp,
  renderGoodVibesVersion,
} from './cli/index.ts';

import { parseGoodVibesCli } from './cli/parser.ts';
import type { GoodVibesCliFlags } from './cli/types.ts';

export const parseCliFlags = createCliFlagParser(parseGoodVibesCli);

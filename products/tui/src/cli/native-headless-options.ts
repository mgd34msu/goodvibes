import {
  catalogValueOptions,
  extractHeadlessInvocation,
  type HeadlessInvocation,
} from '@goodvibes-jev/engine/terminal-shell/native-headless-options';
import { GOODVIBES_CLI_CATALOG } from '@goodvibes-jev/engine/terminal-shell/cli-command-catalog';
export type { NativeHeadlessMode } from '@goodvibes-jev/engine/terminal-shell/native-headless-options';
// Every value-taking flag comes from the catalog; --daemon-home always takes one, --fork may.
const valueOptions = catalogValueOptions(GOODVIBES_CLI_CATALOG, ['--daemon-home']);
export const extractNativeHeadlessOptions = (argv: readonly string[]): HeadlessInvocation =>
  extractHeadlessInvocation(argv, { valueOptions, optional: ['--fork'] });

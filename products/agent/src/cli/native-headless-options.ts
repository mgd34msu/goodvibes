import {
  catalogValueOptions,
  extractHeadlessInvocation,
  type HeadlessInvocation,
} from '@goodvibes-jev/engine/terminal-shell/native-headless-options';
import { AGENT_CLI_CATALOG } from './catalog.ts';
export type { NativeHeadlessMode } from '@goodvibes-jev/engine/terminal-shell/native-headless-options';
// Every value-taking flag comes from the catalog, plus the three that always take one.
const valueOptions = catalogValueOptions(AGENT_CLI_CATALOG, ['--agent-profile', '--runtime-url', '--runtime']);
export const extractNativeHeadlessOptions = (argv: readonly string[]): HeadlessInvocation =>
  extractHeadlessInvocation(argv, { valueOptions });

import { extractNativeHeadlessOptions as extract } from '@goodvibes-jev/engine/terminal-shell/native';
import { catalogValueOptions, extractHeadlessRunFlags, type HeadlessRunFlags } from '@goodvibes-jev/engine/terminal-shell/headless-turn-events';
import { AGENT_CLI_CATALOG } from './catalog.ts';
export type { NativeHeadlessMode } from '@goodvibes-jev/engine/terminal-shell/native';
const grammar = { required: ['--agent-profile', '--runtime-url', '--runtime'] };
const valueOptions = catalogValueOptions(AGENT_CLI_CATALOG, grammar.required);
export const extractNativeHeadlessOptions = (argv: readonly string[]): ReturnType<typeof extract> & { readonly run?: HeadlessRunFlags } => {
  const run = extractHeadlessRunFlags(argv, valueOptions);
  const native = extract(run.argv, { ...grammar, required: [...valueOptions] });
  return { ...native, errors: [...run.errors, ...native.errors], ...(Object.keys(run.flags).length ? { run: run.flags } : {}) };
};

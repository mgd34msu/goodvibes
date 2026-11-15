import { expect, test } from 'bun:test';
import { catalogValueOptions } from '@goodvibes-jev/engine/terminal-shell/headless-turn-events';
import { GOODVIBES_CLI_CATALOG as CATALOG } from '@goodvibes-jev/engine/terminal-shell';
import { extractNativeHeadlessOptions } from '../../cli/native-headless-options.ts';

// A value-taking flag the recovery parser does not know would let the recovery flag after it be read as recovery
// authority instead of as that flag's value.
test('every value-taking flag in the CLI catalog protects a following recovery option', () => {
  for (const option of catalogValueOptions(CATALOG)) {
    const { mode } = extractNativeHeadlessOptions(['run', option, '--intake-cancel']);
    expect({ option, mode }).toEqual({ option, mode: 'submit' });
  }
});

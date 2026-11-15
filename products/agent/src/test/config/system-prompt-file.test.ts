import { afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { getConfiguredSystemPrompt } from '../../config/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

test('an unreadable systemPromptFile is warned about once in the Agent, and the session runs without it', () => {
  const warn = spyOn(logger, 'warn').mockImplementation(() => {});
  restores.push(() => warn.mockRestore());
  const missing = join(makeProjectTempDir('system-prompt-file'), 'no-such-prompt.md');
  const config = { get: () => missing } as unknown as Parameters<typeof getConfiguredSystemPrompt>[0];
  expect(getConfiguredSystemPrompt(config)).toBeUndefined();
  expect(getConfiguredSystemPrompt(config)).toBeUndefined();
  expect(warn).toHaveBeenCalledTimes(1);
});

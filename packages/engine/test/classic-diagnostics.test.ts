import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { readServiceLogPosture } from '../terminal-shell/src/service-posture.js';
import { readEditorMessage } from '../sdk/src/platform/presentation/editor-message.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

test('Classic service logs and editor presentation retain local output without acquiring a decision owner', async () => {
  const fake = fakePort(() => noulAnswer(0.99));
  const previous = installJudgmentPort(fake.port);
  restore = () => { installJudgmentPort(previous); };
  const root = makeProjectTempDir('classic-diagnostics');
  const path = join(root, 'service.log');
  writeFileSync(path, 'Ordinary service log line.\n');
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    let captures = 0;
    const result = await readServiceLogPosture(path, 4096, {}, () => { captures++; throw new Error('No decision owner should be acquired'); });
    expect(result).toMatchObject({ provenance: 'classic', exists: true, tail: 'Ordinary service log line.\n' });
    expect(captures).toBe(0);
    const presentation = await readEditorMessage({ message: 'Saved the file.', kind: 'note', mode: 'create' }, new AbortController().signal);
    expect(presentation).toEqual({ provenance: 'classic' });
  });
  expect(fake.requests).toHaveLength(0);
});

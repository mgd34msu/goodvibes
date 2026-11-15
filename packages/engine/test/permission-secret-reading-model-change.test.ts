/**
 * A semantic "this read touches no secrets" verdict belongs to the decision
 * model that gave it: once another model is installed the same read is asked
 * again instead of being answered from the earlier model's verdict.
 */
import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { forgetReadSecrets, readTouchesSecrets } from '../platform/src/platform/permissions/credential-read-defaults.js';

let previous: JudgmentPort | undefined, installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; forgetReadSecrets(); });
function install(port: JudgmentPort) { const prior = installJudgmentPort(port); if (!installed) previous = prior; installed = true; }

test('a verdict from one decision model is not reused after another model is installed', async () => {
  const first = fakePort(() => noulAnswer(0.01));
  install(first.port);
  expect(await readTouchesSecrets('read', { file: 'src/config.ts' }, '/synthetic')).toBe(false);
  const askedFirst = first.requests.length;
  expect(askedFirst).toBeGreaterThan(0);

  // Same model: the verdict is reused.
  expect(await readTouchesSecrets('read', { file: 'src/config.ts' }, '/synthetic')).toBe(false);
  expect(first.requests).toHaveLength(askedFirst);

  const second = fakePort(() => noulAnswer(0.01));
  install(second.port);
  expect(await readTouchesSecrets('read', { file: 'src/config.ts' }, '/synthetic')).toBe(false);
  expect(second.requests.length).toBeGreaterThan(0);
});

test('a verdict is not reused when the installed port reports a different model', async () => {
  const inner = fakePort(() => noulAnswer(0.01));
  let model = 'model-a';
  install({ get model() { return model; }, ask: inner.port.ask.bind(inner.port) } as JudgmentPort);
  expect(await readTouchesSecrets('read', { file: 'src/config.ts' }, '/synthetic')).toBe(false);
  const asked = inner.requests.length;
  expect(asked).toBeGreaterThan(0);
  expect(await readTouchesSecrets('read', { file: 'src/config.ts' }, '/synthetic')).toBe(false);
  expect(inner.requests).toHaveLength(asked);

  model = 'model-b';
  expect(await readTouchesSecrets('read', { file: 'src/config.ts' }, '/synthetic')).toBe(false);
  expect(inner.requests.length).toBeGreaterThan(asked);
});

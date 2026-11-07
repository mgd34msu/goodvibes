import { expect, test } from 'bun:test';
import { createNativeSubmissionIdentity } from '../terminal-shell/src/native/native-work-submission-host.ts';

const host = () => ({ baseUrl: 'https://host.example.invalid', token: 'synthetic-private-bearer', workspace: process.cwd(),
  journalPath: '/synthetic/submission.json', selectionIdentity: 'selected-owner', expectedPrincipalId: 'pairing:owner' });

test('native submission labels retain exact host observations without exposing the credential', () => {
  const owner = createNativeSubmissionIdentity('paired'), selected = host();
  const original = owner.identify(selected, 'project');
  expect(owner.identify({ ...selected }, 'project')).toBe(original);
  expect(original).not.toContain(selected.token);
  for (const change of [{ token: 'rotated-private-bearer' }, { expectedPrincipalId: 'pairing:another' },
    { selectionIdentity: 'replaced-selection' }, { baseUrl: 'https://another.example.invalid' }, { journalPath: '/synthetic/another.json' }]) {
    expect(owner.identify({ ...selected, ...change }, 'project')).not.toBe(original);
    expect(owner.identify(selected, 'project')).not.toBe(original);
  }
  owner.clear();
});

test('native submission identities belong to one live owner and clear at retirement', () => {
  const first = createNativeSubmissionIdentity(), second = createNativeSubmissionIdentity(), selected = host();
  const original = first.identify(selected, 'project');
  expect(second.identify(selected, 'project')).not.toBe(original);
  first.clear();
  expect(first.identify(selected, 'project')).not.toBe(original);
});

test('independent project observations stay stable within the bounded live selection', () => {
  const owner = createNativeSubmissionIdentity(), selected = host();
  const first = owner.identify(selected, 'first');
  owner.identify(selected, 'second');
  expect(owner.identify(selected, 'first')).toBe(first);
  for (let index = 0; index < 16; index++) owner.identify(selected, `later-${index}`);
  expect(owner.identify(selected, 'first')).not.toBe(first);
  owner.clear();
});

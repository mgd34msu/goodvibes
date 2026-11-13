/**
 * A submission that stops being current mid-flight must not leave `pending` behind.
 *
 * The early `if (!current()) return` exits inside run() skipped the only place
 * that settled `last`, so a selection that flipped away and back showed a
 * submission as pending that nothing was working on any more.
 */
import { expect, test } from 'bun:test';
import { NativeWorkSubmissionControls, type NativeWorkSubmissionSelection } from '../../runtime/native-work-submission.ts';
import type { NativeSubmissionJournalRecord } from '../../runtime/native-work-submission-journal.ts';

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function fixture() {
  let identity = 'owner-one';
  let releasePrincipal: (principal: string) => void = () => {};
  const records = new Map<string, NativeSubmissionJournalRecord>();
  const selection = (): NativeWorkSubmissionSelection => ({
    available: true,
    identity,
    endpoint: 'https://fixture.invalid',
    projectId: 'p',
    workspace: '/fixture',
    journal: {
      async read(binding) { return records.get(JSON.stringify(binding)); },
      async save(binding, command) { records.set(JSON.stringify(binding), { binding, command }); },
      async confirm() {},
    },
    bind: () => ({
      client: { async submit() { throw new Error('must not be reached'); }, async get() { return { kind: 'not-found' as const }; }, dispose() {} },
      readPrincipal: () => new Promise<string>((resolve) => { releasePrincipal = resolve; }),
      readSnapshot: async () => ({ projectId: 'p', revision: 1, cursor: 1, works: [] }),
      dispose() {},
    }),
  });
  return {
    controls: new NativeWorkSubmissionControls(selection),
    flip: (value: string) => { identity = value; },
    releasePrincipal: (principal: string) => releasePrincipal(principal),
  };
}

test('a run that loses its selection mid-flight does not leave pending behind', async () => {
  const f = fixture();
  const run = f.controls.submitSource({ goal: 'goal', criteria: ['one'] });
  await tick();
  expect(f.controls.state?.status).toBe('pending');

  f.flip('owner-two');
  f.releasePrincipal('principal-one');
  expect(await run).toBeUndefined();

  f.flip('owner-one');
  expect(f.controls.state).toBeUndefined();
});

test('a settled result is still returned and kept when the run stays current', async () => {
  const f = fixture();
  const run = f.controls.status();
  await tick();
  f.releasePrincipal('principal-one');
  const state = await run;
  expect(state?.status).toBe('unavailable');
  expect(f.controls.state).toBe(state);
});

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeWorkSubmissionControls, type NativeWorkSubmissionSelection } from '../terminal-shell/src/native/native-work-submission.js';
import {
  NATIVE_SUBMISSION_JOURNAL_MAX_RECORDS,
  NativeWorkSubmissionJournal,
  type NativeSubmissionJournalBinding,
} from '../terminal-shell/src/native/native-work-submission-journal.js';
import type { NativeWorkSubmissionReceipt, NativeWorkSubmissionRequest, OperatorNativeWorkSubmissionClient } from '../platform/src/platform/workflow/work-ledger/native-submission-client.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const command = (id: string): NativeWorkSubmissionRequest => ({ requestId: `request-${id}`, inputId: `input-${id}`, expectedRevision: 1, goal: 'Goal', criteria: ['one'] });
const bindingFor = (workspace: string): NativeSubmissionJournalBinding => ({ endpoint: 'http://127.0.0.1:7777', projectId: 'p', workspace, principalId: 'principal' });
const receipt = (request: NativeWorkSubmissionRequest): NativeWorkSubmissionReceipt => ({
  projectId: 'p', requestId: request.requestId, inputId: request.inputId, ledgerRevision: 2, workId: 'w', attemptId: 'a',
  expectedRevision: { work: 1, criteria: 1, attempt: 1 },
  source: { version: 1, sourceId: 's', sourceRevision: 'r', sessionId: 'x' }, goal: request.goal, criteria: [...request.criteria],
});

describe('native submission journal capacity', () => {
  function journal(): NativeWorkSubmissionJournal {
    const directory = mkdtempSync(join(tmpdir(), 'native-journal-release-'));
    directories.push(directory);
    return new NativeWorkSubmissionJournal(join(directory, 'journal.json'));
  }

  test('removing a settled record frees its slot for a new binding, and only the exact request is removed', async () => {
    const j = journal();
    for (let index = 0; index < NATIVE_SUBMISSION_JOURNAL_MAX_RECORDS; index++) await j.save(bindingFor(`/w${index}`), command(String(index)), null);
    await expect(j.save(bindingFor('/extra'), command('extra'), null)).rejects.toMatchObject({ code: 'journal_limit' });
    await expect(j.remove(bindingFor('/w0'), 'request-other')).rejects.toMatchObject({ code: 'conflict' });
    expect(await j.read(bindingFor('/w0'))).toBeDefined();
    await j.remove(bindingFor('/w0'), 'request-0');
    expect(await j.read(bindingFor('/w0'))).toBeUndefined();
    await j.save(bindingFor('/extra'), command('extra'), null);
    expect(await j.read(bindingFor('/extra'))).toBeDefined();
    // Unresolved records are never evicted to make room.
    expect(await j.read(bindingFor('/w1'))).toBeDefined();
  });
});

describe('native submission controls', () => {
  function setup(options: { readonly snapshotFails?: () => boolean; readonly keepSettled?: boolean } = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'native-submission-controls-'));
    directories.push(directory);
    const real = new NativeWorkSubmissionJournal(join(directory, 'journal.json'));
    const client: OperatorNativeWorkSubmissionClient = {
      async submit(request) { return { kind: 'submitted', replayed: false, receipt: receipt(request) }; },
      async get() { return { kind: 'not-found' }; },
      dispose() {},
    };
    const selection = (): NativeWorkSubmissionSelection => ({
      available: true, identity: 'host', endpoint: 'http://127.0.0.1:7777', projectId: 'p', workspace: '/fixture',
      // A journal without `remove` keeps settled records, so the earlier request is still the reused draft.
      journal: options.keepSettled ? { read: (b) => real.read(b), save: (b, c, e) => real.save(b, c, e), confirm: (b, c) => real.confirm(b, c) } : real,
      bind: () => ({
        client, readPrincipal: async () => 'principal',
        readSnapshot: async () => {
          if (options.snapshotFails?.()) throw new Error('network down');
          return { projectId: 'p', revision: 3, cursor: 3, works: [] };
        },
        dispose() {},
      }),
    });
    let ids = 0;
    return { controls: new NativeWorkSubmissionControls(selection, () => `id-${++ids}`), journal: real };
  }
  const source = { goal: 'Goal', criteria: ['one'] };

  test('a submission that has its receipt releases its journal slot', async () => {
    const { controls, journal } = setup();
    const result = await controls.submitSource(source);
    expect(result?.status).toBe('submitted');
    expect(await journal.read({ endpoint: 'http://127.0.0.1:7777', projectId: 'p', workspace: '/fixture', principalId: 'principal' })).toBeUndefined();
  });

  test('a full journal of other workspaces names the file that holds them instead of pointing at status', async () => {
    const { controls, journal } = setup();
    for (let i = 0; i < NATIVE_SUBMISSION_JOURNAL_MAX_RECORDS; i += 1) {
      await journal.save(bindingFor(`/other-${i}`), command(`other-${i}`), null);
    }
    const result = await controls.submitSource(source);
    expect(result?.status).toBe('unavailable');
    expect(result?.message).toContain(journal.path);
    expect(result?.message).toContain('No submission was sent');
  });

  test('a failed snapshot for a new submission does not blame the earlier request that already completed', async () => {
    let fail = false;
    const { controls } = setup({ snapshotFails: () => fail, keepSettled: true });
    expect((await controls.submitSource(source))?.status).toBe('submitted');
    fail = true;
    const second = await controls.submitSource(source);
    expect(second?.status).toBe('unavailable');
    expect(second?.request).toBeUndefined();
    expect(second?.message).not.toContain('outcome is unknown');
  });
});

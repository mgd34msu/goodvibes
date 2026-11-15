import { describe, expect, test } from 'bun:test';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { settingsCommitWarning, settingsThrownFailure } from '../../tools/agent-settings-admission.ts';
import { importReceiptResult } from '../../tools/agent-settings-import-admission.ts';
import { settingsOutcomeError } from '../../tools/agent-settings-outcome.ts';

describe('a settings call that threw', () => {
  test('a missing or stale admission is reported as the authorization hold it is', () => {
    const mutation = settingsThrownFailure('mutation', new ToolInputProjectionError('held')).error;
    expect(mutation).toStartWith('Settings mutation requires a current recorded effect-owner admission.');
    expect(mutation).toContain('only for what the owner asked in this turn');
    expect(mutation).toContain('confirm and explicitUserRequest are not authority');
    expect(mutation).toContain('Ask the owner to make the request');
    expect(settingsThrownFailure('import', new ToolInputProjectionError('stale')).error)
      .toStartWith('Settings import requires a current recorded effect-owner admission.');
  });

  test('any other failure names its cause and says to read the setting back, not to ask for approval', () => {
    const failure = settingsThrownFailure('mutation', new Error('EACCES: permission denied, rename config.json'));
    expect(failure.success).toBe(false);
    expect(failure.error).toContain('EACCES: permission denied');
    expect(failure.error).toContain('may or may not have been applied');
    expect(failure.error).toContain('read the setting before requesting it again');
    expect(failure.error).not.toContain('admission');
  });
});

describe('a committed setting that could not be read back', () => {
  test('carries a warning instead of reading as plain success', () => {
    expect(settingsCommitWarning('committed', false)).toContain('not confirmed');
    expect(settingsCommitWarning('committed', false)).toContain('Read the setting');
  });

  test('says nothing when it was read back, or when the outcome is not a commit', () => {
    expect(settingsCommitWarning('committed', true)).toBeUndefined();
    expect(settingsCommitWarning('partial', false)).toBeUndefined();
    expect(settingsCommitWarning('unknown', false)).toBeUndefined();
  });
});

describe('an import receipt', () => {
  test('a refused import says nothing changed and does not read as partial', () => {
    const result = importReceiptResult({ status: 'unknown', refused: true, refusalReason: 'stale', completedPaths: [] }, false);
    expect(result.success).toBe(false);
    expect(result.error).toContain('refused this import before applying anything');
    expect(result.error).toContain('Nothing changed');
    expect(JSON.parse(result.output)).toMatchObject({ status: 'refused', refusalReason: 'stale' });
  });

  test('a partial import names the written paths and says to read before importing again', () => {
    const result = importReceiptResult({ status: 'partial', completedPaths: ['/a'], uncertainPath: '/b' }, false);
    expect(result.error).toContain('partly applied');
    expect(result.error).toContain('read the imported settings');
    expect(JSON.parse(result.output).uncertainPath).toBe('/b');
  });

  test('a commit the owners could not confirm is not called partial', () => {
    const result = importReceiptResult({ status: 'committed', completedPaths: ['/a'] }, false);
    expect(result.success).toBe(false);
    expect(result.error).toContain('committed but could not be confirmed');
    expect(result.error).not.toContain('partly');
  });

  test('a verified commit is a success with no error', () => {
    const result = importReceiptResult({ status: 'committed', completedPaths: ['/a'] }, true);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe('settings outcome wording', () => {
  test('a single change keeps its wording', () => {
    expect(settingsOutcomeError('unknown', false)).toContain('The settings change has an unknown outcome');
    expect(settingsOutcomeError('partial', true, 'managed')).toContain('this change before applying anything (managed');
  });
});

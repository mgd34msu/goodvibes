/**
 * A refused installed-image admission is returned with its reason and the way
 * forward, so the entry point can still answer metadata commands and then stop
 * with one line instead of a stack trace at import time.
 */
import { describe, expect, test } from 'bun:test';
import { admitInstalledDataWriterOrExplain } from '../../runtime/native-data-writer.ts';

const OPTIONS = { moduleUrl: 'file:///x', execPath: '/opt/gv/goodvibes', compiledVersion: '3.3.0', platform: 'linux' };

describe('installed data writer admission', () => {
  test('a refusal is returned, not thrown, and names the cause and the next step', () => {
    const admission = admitInstalledDataWriterOrExplain(OPTIONS, () => { throw new Error('Installed data publisher image is unavailable'); });
    expect(admission.ok).toBe(false);
    if (admission.ok) return;
    expect(admission.message).toContain('Installed data publisher image is unavailable');
    expect(admission.message).toContain('official installer');
  });

  test('an admitted install passes its publisher through unchanged', () => {
    const owner = { admitted: true } as never;
    expect(admitInstalledDataWriterOrExplain(OPTIONS, () => owner)).toEqual({ ok: true, writer: owner });
  });
});

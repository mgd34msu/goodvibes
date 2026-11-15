/**
 * A refused installed-image admission explains itself: it names what was wrong
 * and the way forward, instead of a bare internal message at import time.
 */
import { describe, expect, test } from 'bun:test';
import { admitInstalledDataWriterOrExplain } from '../../runtime/native-data-writer.ts';

const OPTIONS = { moduleUrl: 'file:///x', execPath: '/opt/gv/goodvibes-agent', compiledVersion: '3.3.0', platform: 'linux' };

describe('installed data writer admission', () => {
  test('a refusal keeps its cause and names the next step', () => {
    const refusal = new Error('Installed data publisher image is unavailable');
    let thrown: unknown;
    try {
      admitInstalledDataWriterOrExplain(OPTIONS, () => { throw refusal; });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('Installed data publisher image is unavailable');
    expect(message).toContain('official installer');
    expect((thrown as Error).cause).toBe(refusal);
  });

  test('an admitted install passes through unchanged', () => {
    const owner = { admitted: true } as never;
    expect(admitInstalledDataWriterOrExplain(OPTIONS, () => owner)).toBe(owner);
  });
});

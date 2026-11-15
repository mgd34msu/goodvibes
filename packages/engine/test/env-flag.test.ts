import { expect, test } from 'bun:test';
import { envFlag } from '../platform/src/platform/utils/env-flag.ts';

test('1 and true in any case or padding turn a switch on', () => {
  for (const value of ['1', 'true', 'TRUE', ' True ']) expect(envFlag(value)).toBe(true);
});

test('0, false, empty, unset and other text leave a switch off', () => {
  for (const value of ['0', 'false', '', undefined, 'yes', 'on']) expect(envFlag(value)).toBe(false);
});

test('a notify suppression switch set to text other than 1 or true does not suppress', async () => {
  const { isNotifySuppressed } = await import('../platform/src/platform/utils/notify.ts');
  const saved = { node: process.env.NODE_ENV, flag: process.env.GOODVIBES_SUPPRESS_NOTIFY };
  try {
    process.env.NODE_ENV = 'production';
    process.env.GOODVIBES_SUPPRESS_NOTIFY = 'yes';
    expect(isNotifySuppressed()).toBe(false);
    process.env.GOODVIBES_SUPPRESS_NOTIFY = '1';
    expect(isNotifySuppressed()).toBe(true);
  } finally {
    if (saved.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.node;
    if (saved.flag === undefined) delete process.env.GOODVIBES_SUPPRESS_NOTIFY; else process.env.GOODVIBES_SUPPRESS_NOTIFY = saved.flag;
  }
});

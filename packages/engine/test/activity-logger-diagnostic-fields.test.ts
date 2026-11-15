import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLogger } from '../platform/src/platform/utils/logger.js';

describe('activity log diagnostic fields', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-log-fields-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('keeps the path, syscall and delay of a failed operation and still withholds text and secrets', () => {
    const log = new ActivityLogger();
    log.configure(dir);
    log.error('[x] could not persist', {
      filePath: '/a/b', syscall: 'rename', command: 'xdg-open', delayMs: 250, error: 'boom', token: 'hunter2zzz', mystery: 'value',
    });
    log.flushSync();
    const text = readFileSync(join(dir, 'activity.md'), 'utf-8');
    expect(text).toContain('"filePath": "/a/b"');
    expect(text).toContain('"syscall": "rename"');
    expect(text).toContain('"command": "xdg-open"');
    expect(text).toContain('"delayMs": 250');
    expect(text).toContain('"error": "[REDACTED_TEXT]"');
    expect(text).toContain('"mystery": "[REDACTED]"');
    expect(text).not.toContain('hunter2zzz');
    log.dispose();
  });
});

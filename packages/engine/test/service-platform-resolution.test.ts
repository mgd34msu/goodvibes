import { describe, expect, test } from 'bun:test';
import { detectPlatform } from '../platform/src/platform/daemon/service-manager.js';

describe('service.platform resolution', () => {
  test.each([
    ['darwin', 'launchd'],
    ['win32', 'windows'],
    ['linux', 'systemd'],
    ['freebsd', 'manual'],
    ['aix', 'manual'],
  ] as const)('auto on %s resolves to %s', (host, expected) => {
    expect(detectPlatform('auto', host)).toBe(expected);
  });

  test('an unrecognised configured value resolves like auto', () => {
    expect(detectPlatform('bogus', 'linux')).toBe('systemd');
    expect(detectPlatform('bogus', 'freebsd')).toBe('manual');
  });

  test.each(['systemd', 'launchd', 'windows', 'manual'] as const)('an explicit %s wins over the host', (configured) => {
    expect(detectPlatform(configured, 'darwin')).toBe(configured);
    expect(detectPlatform(configured, 'linux')).toBe(configured);
  });
});

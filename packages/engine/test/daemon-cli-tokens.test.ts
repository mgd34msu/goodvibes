import { describe, expect, test } from 'bun:test';
import { readDaemonCliTokens } from '../platform/src/platform/daemon/cli-tokens.js';

describe('daemon CLI token environment', () => {
  test('a blank daemon or HTTP token is unset, so the HTTP listener falls back to the daemon token', () => {
    expect(readDaemonCliTokens({ GOODVIBES_DAEMON_TOKEN: 'daemon', GOODVIBES_HTTP_TOKEN: '' })).toEqual({ daemonToken: 'daemon', httpToken: 'daemon' });
    expect(readDaemonCliTokens({ GOODVIBES_DAEMON_TOKEN: '  ', GOODVIBES_HTTP_TOKEN: '\t' })).toEqual({ daemonToken: undefined, httpToken: undefined });
  });

  test('a set HTTP token wins over the daemon token', () => {
    expect(readDaemonCliTokens({ GOODVIBES_DAEMON_TOKEN: 'daemon', GOODVIBES_HTTP_TOKEN: 'http' })).toEqual({ daemonToken: 'daemon', httpToken: 'http' });
  });
});

import { describe, expect, test } from 'bun:test';
import { classifyBindPosture, isLoopbackHost } from '@goodvibes-jev/engine/terminal-shell';

describe('bind posture', () => {
  test('real loopback addresses are local', () => {
    for (const host of ['localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) expect(isLoopbackHost(host)).toBe(true);
  });

  test('a hostname that only starts with 127. is a custom network bind', () => {
    expect(isLoopbackHost('127.example.com')).toBe(false);
    const posture = classifyBindPosture({ hostMode: 'custom', host: '127.example.com' });
    expect(posture.kind).toBe('custom-network');
    expect(posture.networkFacing).toBe(true);
  });

  test('other addresses are not loopback', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.5', '::ffff:10.0.0.1', '128.0.0.1']) expect(isLoopbackHost(host)).toBe(false);
  });
});

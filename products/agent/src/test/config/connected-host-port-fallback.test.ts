import { describe, expect, test } from 'bun:test';
import { connectedHostBaseUrl, connectedHostPort } from '../../config/connected-host-dial.ts';

describe('connectedHostPort', () => {
  test('falls back for values that are not a usable TCP port', () => {
    for (const unusable of [null, undefined, '', '  ', 0, -1, 1.5, 70000, 'nonsense', NaN]) {
      expect(connectedHostPort(unusable, 3421)).toBe(3421);
    }
  });

  test('keeps a valid port given as a number or a numeric string', () => {
    expect(connectedHostPort(8080)).toBe(8080);
    expect(connectedHostPort('8080')).toBe(8080);
    expect(connectedHostBaseUrl('127.0.0.1', null)).toBe('http://127.0.0.1:3421');
  });
});

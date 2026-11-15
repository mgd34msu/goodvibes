import { afterEach, describe, expect, test } from 'bun:test';
import { isInsecureTransportOrigin } from './insecure-origin';

function setOrigin(url: string): void {
  (globalThis as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(url);
}
afterEach(() => setOrigin('http://localhost/'));

describe('isInsecureTransportOrigin', () => {
  test('a wildcard bind address typed as the origin is a working local setup, not an HTTPS wall', () => {
    setOrigin('http://0.0.0.0:3421/');
    expect(isInsecureTransportOrigin()).toBe(false);
  });

  test('plain http on a Tailscale name or address opens the app', () => {
    for (const origin of ['http://box.tail1234.ts.net:3421/', 'http://100.101.102.103:3421/']) {
      setOrigin(origin);
      expect(isInsecureTransportOrigin()).toBe(false);
    }
  });

  test('plain http on a public host is walled; https on the same host is not', () => {
    setOrigin('http://8.8.8.8:3421/');
    expect(isInsecureTransportOrigin()).toBe(true);
    setOrigin('https://8.8.8.8:3421/');
    expect(isInsecureTransportOrigin()).toBe(false);
  });

  test('the explicit insecure-transport override lifts the wall', () => {
    const env = (globalThis as { process: { env: Record<string, string | undefined> } }).process.env;
    const before = env.GOODVIBES_ALLOW_INSECURE_TRANSPORT;
    try {
      for (const on of ['true', '1']) {
        env.GOODVIBES_ALLOW_INSECURE_TRANSPORT = on;
        setOrigin('http://8.8.8.8:3421/');
        expect(isInsecureTransportOrigin()).toBe(false);
      }
      env.GOODVIBES_ALLOW_INSECURE_TRANSPORT = 'yes';
      expect(isInsecureTransportOrigin()).toBe(true);
    } finally {
      if (before === undefined) delete env.GOODVIBES_ALLOW_INSECURE_TRANSPORT;
      else env.GOODVIBES_ALLOW_INSECURE_TRANSPORT = before;
    }
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { isPrivateNetworkHost as transportIsPrivateNetworkHost } from '@goodvibes-jev/engine/transport-http';
import { isInsecureTransportOrigin, isPrivateNetworkHost } from './insecure-origin';

const hosts = [
  'localhost', 'app.localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0',
  'nas.local', '10.1.1.1', '172.16.0.1', '172.31.255.1', '172.32.0.1', '192.168.1.5', '192.169.1.5',
  '8.8.8.8', 'example.com', '[2001:db8::1]',
];

describe('the guard agrees with the transport about which hosts are private', () => {
  for (const host of hosts) {
    test(host, () => {
      expect(isPrivateNetworkHost(host)).toBe(transportIsPrivateNetworkHost(host));
    });
  }
});

function setOrigin(url: string): void {
  (globalThis as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(url);
}
afterEach(() => setOrigin('http://localhost/'));

describe('isInsecureTransportOrigin', () => {
  test('a wildcard bind address typed as the origin is a working local setup, not an HTTPS wall', () => {
    setOrigin('http://0.0.0.0:3421/');
    expect(isInsecureTransportOrigin()).toBe(false);
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

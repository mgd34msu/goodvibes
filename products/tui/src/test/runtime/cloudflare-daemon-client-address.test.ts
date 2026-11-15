/**
 * The Cloudflare provisioning client sends the daemon bearer token, so it must
 * dial the daemon the way every other operator seam does: the scheme from the
 * TLS mode, the configured port, and nothing at all when there is no daemon.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { createCloudflareDaemonClient, resolveCloudflareDaemonBaseUrl } from '../../runtime/cloudflare-control-plane.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let home: string;
beforeEach(() => { home = makeProjectTempDir('gv-cloudflare-address'); });
afterEach(() => { if (existsSync(home)) rmSync(home, { recursive: true, force: true }); });

function config(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as never;
}
const BASE = { 'daemon.enabled': true, 'controlPlane.host': '127.0.0.1', 'controlPlane.port': 3421, 'controlPlane.tls.mode': 'off' };

describe('where the Cloudflare client dials', () => {
  test('a TLS control plane is reached over https, on the configured port', () => {
    expect(resolveCloudflareDaemonBaseUrl(config({ ...BASE, 'controlPlane.tls.mode': 'on', 'controlPlane.port': 4443 })))
      .toBe('https://127.0.0.1:4443');
  });

  test('a wildcard bind is dialled on loopback', () => {
    expect(resolveCloudflareDaemonBaseUrl(config({ ...BASE, 'controlPlane.host': '0.0.0.0' }))).toBe('http://127.0.0.1:3421');
  });

  test('a disabled daemon or an unset address is no address, never a guessed one', () => {
    expect(resolveCloudflareDaemonBaseUrl(config({ ...BASE, 'daemon.enabled': false }))).toBeNull();
    expect(resolveCloudflareDaemonBaseUrl(config({ 'daemon.enabled': true }))).toBeNull();
  });

  test('a request with no address is refused with the next step and sends nothing', async () => {
    let sent = 0;
    const client = createCloudflareDaemonClient({
      configManager: config({ 'daemon.enabled': true }),
      homeDirectory: home,
      fetch: (async () => { sent++; return new Response('{}'); }) as unknown as typeof fetch,
    });

    const error = await client.status().catch((e: unknown) => e as { code?: string; message: string });

    expect(sent).toBe(0);
    expect((error as { code?: string }).code).toBe('CLOUDFLARE_DAEMON_UNAVAILABLE');
    expect((error as Error).message).toContain('controlPlane.host');
  });

  test('the bearer goes to the https address when TLS is on', async () => {
    const seen: string[] = [];
    const client = createCloudflareDaemonClient({
      configManager: config({ ...BASE, 'controlPlane.tls.mode': 'on' }),
      homeDirectory: home,
      fetch: (async (input: string | URL | Request) => { seen.push(String(input)); return new Response('{}'); }) as unknown as typeof fetch,
    });

    await client.status();

    expect(seen).toEqual(['https://127.0.0.1:3421/api/cloudflare/status']);
  });

  test('a non-JSON answer names the HTTP status and shows the start of the body', async () => {
    const client = createCloudflareDaemonClient({
      configManager: config(BASE),
      homeDirectory: home,
      fetch: (async () => new Response(`<html>${'x'.repeat(500)}`, { status: 502 })) as unknown as typeof fetch,
    });

    const error = await client.status().catch((e: unknown) => e as { status?: number; message: string });

    expect((error as { status?: number }).status).toBe(502);
    expect((error as Error).message).toContain('HTTP 502');
    expect((error as Error).message).toContain('<html>');
    expect((error as Error).message.length).toBeLessThan(320);
  });
});

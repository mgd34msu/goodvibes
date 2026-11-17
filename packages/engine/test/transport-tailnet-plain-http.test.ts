/**
 * The plain-http wall in front of the operator bearer token. A 100.64/10
 * address is shared address space: Tailscale uses it and so does carrier-grade
 * NAT, so plain http to one sends the token across the ISP's network unless the
 * address is stated to be a Tailscale address (by Tailscale's own list, or the
 * owner's GOODVIBES_TAILNET_ADDRESSES). A `*.ts.net` name is the tailnet signal.
 *
 * Real transport and URL rule; only the network is a recorder at the fetch seam.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHttpJsonTransport } from '../transport-http/src/http-core.ts';
import { stateTailnetAddresses } from '../transport-http/src/paths.ts';

const sent: { url: string; authorization: string | null }[] = [];
const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  sent.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const transportFor = (baseUrl: string) => createHttpJsonTransport({ baseUrl, authToken: 'operator-token', fetchImpl });
const previousSetting = process.env['GOODVIBES_TAILNET_ADDRESSES'];

afterEach(() => {
  sent.length = 0;
  if (previousSetting === undefined) delete process.env['GOODVIBES_TAILNET_ADDRESSES'];
  else process.env['GOODVIBES_TAILNET_ADDRESSES'] = previousSetting;
});

describe('plain http to a 100.64/10 address', () => {
  test('is refused before the token is sent unless the address is a stated Tailscale address', async () => {
    delete process.env['GOODVIBES_TAILNET_ADDRESSES'];
    expect(() => transportFor('http://100.70.1.2:3423')).toThrow(expect.objectContaining({ code: 'ENGINE_TRANSPORT_INSECURE_BASE_URL' }));
    expect(sent).toHaveLength(0);

    stateTailnetAddresses(['100.70.1.2']);
    await transportFor('http://100.70.1.2:3423').requestJson('/status');
    expect(sent).toEqual([{ url: 'http://100.70.1.2:3423/status', authorization: 'Bearer operator-token' }]);

    // Stating one address does not open the range.
    expect(() => transportFor('http://100.70.1.3:3423')).toThrow(expect.objectContaining({ code: 'ENGINE_TRANSPORT_INSECURE_BASE_URL' }));
    expect(sent).toHaveLength(1);
  });

  test('is accepted when the owner lists it, and a Tailscale name is accepted as it is', async () => {
    process.env['GOODVIBES_TAILNET_ADDRESSES'] = '100.99.0.1, 100.99.0.2';
    await transportFor('http://100.99.0.2:3423').requestJson('/status');
    process.env['GOODVIBES_TAILNET_ADDRESSES'] = '100.64.0.0/10';
    await transportFor('http://100.101.0.9:3423').requestJson('/status');
    delete process.env['GOODVIBES_TAILNET_ADDRESSES'];
    await transportFor('http://box.tail1234.ts.net:3423').requestJson('/status');
    expect(sent.map((request) => request.url)).toEqual([
      'http://100.99.0.2:3423/status',
      'http://100.101.0.9:3423/status',
      'http://box.tail1234.ts.net:3423/status',
    ]);
  });
});

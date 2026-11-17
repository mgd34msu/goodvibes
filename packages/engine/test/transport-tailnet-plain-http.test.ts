// Proves: The operator bearer token is sent over plain http to a public address, or to a 100.64/10 address not stated to be Tailscale.
// Red when: A transport for http://203.0.113.9 or http://100.70.1.2 is built and sends the Authorization header, or stating one 100.64/10 address opens the rest of the range.
/**
 * The plain-http wall in front of the operator bearer token. A public address
 * is refused over http and reached over https. A 100.64/10
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
import { replaceTailscaleStatusProbe } from '../transport-http/src/private-network.ts';

const sent: { url: string; authorization: string | null }[] = [];
const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  sent.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const transportFor = (baseUrl: string) => createHttpJsonTransport({ baseUrl, authToken: 'operator-token', fetchImpl });
const previousSetting = process.env['GOODVIBES_TAILNET_ADDRESSES'];
const previousInsecure = process.env['GOODVIBES_ALLOW_INSECURE_TRANSPORT'];

afterEach(() => {
  sent.length = 0;
  replaceTailscaleStatusProbe(null);
  if (previousSetting === undefined) delete process.env['GOODVIBES_TAILNET_ADDRESSES'];
  else process.env['GOODVIBES_TAILNET_ADDRESSES'] = previousSetting;
  if (previousInsecure === undefined) delete process.env['GOODVIBES_ALLOW_INSECURE_TRANSPORT'];
  else process.env['GOODVIBES_ALLOW_INSECURE_TRANSPORT'] = previousInsecure;
});

describe('plain http to an address outside a private network', () => {
  test('is refused before the token is sent unless the address is a stated Tailscale address', async () => {
    delete process.env['GOODVIBES_TAILNET_ADDRESSES'];
    delete process.env['GOODVIBES_ALLOW_INSECURE_TRANSPORT'];
    // This machine's own Tailscale states nothing.
    replaceTailscaleStatusProbe(() => null);
    // A public address: refused over http, reached over https.
    expect(() => transportFor('http://203.0.113.9:3421')).toThrow(expect.objectContaining({ code: 'ENGINE_TRANSPORT_INSECURE_BASE_URL' }));
    expect(sent).toHaveLength(0);
    await transportFor('https://203.0.113.9:3421').requestJson('/status');
    expect(sent.splice(0)).toEqual([{ url: 'https://203.0.113.9:3421/status', authorization: 'Bearer operator-token' }]);

    expect(() => transportFor('http://100.70.1.2:3423')).toThrow(expect.objectContaining({ code: 'ENGINE_TRANSPORT_INSECURE_BASE_URL' }));
    expect(sent).toHaveLength(0);

    stateTailnetAddresses(['100.70.1.2']);
    await transportFor('http://100.70.1.2:3423').requestJson('/status');
    expect(sent).toEqual([{ url: 'http://100.70.1.2:3423/status', authorization: 'Bearer operator-token' }]);

    // Stating one address does not open the range.
    expect(() => transportFor('http://100.70.1.3:3423')).toThrow(expect.objectContaining({ code: 'ENGINE_TRANSPORT_INSECURE_BASE_URL' }));
    expect(sent).toHaveLength(1);
  });
});

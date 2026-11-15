import { describe, test, expect } from 'bun:test';
import {
  resolveStableHost,
  mdnsLocalName,
  parseDefaultRouteInterface,
  parseTailscaleStatus,
  firstNonInternalIpv4,
  resolvesToThisHost,
  stableUrlHostForBindHost,
  type StableHostInputs,
} from '../platform/src/platform/pairing/stable-host.ts';
import { normalizeBaseUrl } from '../transport-http/src/paths.ts';

describe('resolveStableHost ladder', () => {
  test('tailscale MagicDNS wins when tailscale is up', () => {
    const inputs: StableHostInputs = {
      hostname: 'workshop.lan',
      gatewayInterfaceIp: '192.168.1.42',
      firstNonInternalIp: '192.168.1.42',
      tailscale: { up: true, magicDnsName: 'workshop.tail1234.ts.net.' },
    };
    expect(resolveStableHost(inputs)).toEqual({ host: 'workshop.tail1234.ts.net', kind: 'tailscale-magicdns', stable: true, alternateHost: '192.168.1.42' });
  });

  test('the transport accepts every name the ladder offers over plain http', () => {
    const tailnet = resolveStableHost({ hostname: 'box', tailscale: { up: true, magicDnsName: 'box.tail1234.ts.net.' } });
    expect(() => normalizeBaseUrl(`http://${tailnet.host}:3421`)).not.toThrow();
    const local = resolveStableHost({ hostname: 'box', mdnsResolvesToThisHost: true });
    expect(() => normalizeBaseUrl(`http://${local.host}:3421`)).not.toThrow();
  });

  test('tailscale down falls through to mDNS .local even with a MagicDNS name present', () => {
    const inputs: StableHostInputs = {
      hostname: 'workshop',
      gatewayInterfaceIp: '192.168.1.42',
      tailscale: { up: false, magicDnsName: 'workshop.tail1234.ts.net' },
      mdnsResolvesToThisHost: true,
    };
    expect(resolveStableHost(inputs)).toEqual({ host: 'workshop.local', kind: 'mdns-local', stable: true, alternateHost: '192.168.1.42' });
  });

  test('no tailscale: mDNS .local from the first hostname label when it resolves here', () => {
    const inputs: StableHostInputs = { hostname: 'workshop.internal.example', gatewayInterfaceIp: '10.0.0.5', mdnsResolvesToThisHost: true };
    expect(resolveStableHost(inputs)).toEqual({ host: 'workshop.local', kind: 'mdns-local', stable: true, alternateHost: '10.0.0.5' });
  });

  test('a .local name that did not resolve to this host is not offered', () => {
    for (const evidence of [false, undefined]) {
      const inputs: StableHostInputs = { hostname: 'workshop', gatewayInterfaceIp: '10.0.0.5', mdnsResolvesToThisHost: evidence };
      expect(resolveStableHost(inputs)).toEqual({ host: '10.0.0.5', kind: 'gateway-interface', stable: false });
    }
  });

  test('no stable name: gateway-routed interface address, marked unstable', () => {
    const inputs: StableHostInputs = { hostname: 'localhost', gatewayInterfaceIp: '10.0.0.5', firstNonInternalIp: '172.17.0.1' };
    expect(resolveStableHost(inputs)).toEqual({ host: '10.0.0.5', kind: 'gateway-interface', stable: false });
  });

  test('gateway address preferred over the first-non-internal fallback', () => {
    const inputs: StableHostInputs = { hostname: 'localhost', gatewayInterfaceIp: '10.0.0.5', firstNonInternalIp: '172.17.0.1' };
    expect(resolveStableHost(inputs).host).toBe('10.0.0.5');
  });

  test('falls back to firstNonInternalIp when no gateway route resolved', () => {
    const inputs: StableHostInputs = { hostname: 'localhost', firstNonInternalIp: '192.168.5.9' };
    expect(resolveStableHost(inputs)).toEqual({ host: '192.168.5.9', kind: 'first-interface', stable: false });
  });

  test('nothing routable: loopback', () => {
    expect(resolveStableHost({ hostname: 'localhost' })).toEqual({ host: '127.0.0.1', kind: 'loopback', stable: false });
  });

  test('a DHCP lease change does not change a resolved stable name', () => {
    const before: StableHostInputs = { hostname: 'workshop', gatewayInterfaceIp: '192.168.1.42', mdnsResolvesToThisHost: true };
    const after: StableHostInputs = { hostname: 'workshop', gatewayInterfaceIp: '192.168.1.77', mdnsResolvesToThisHost: true };
    expect(resolveStableHost(before).host).toBe(resolveStableHost(after).host);
    expect(resolveStableHost(before).host).toBe('workshop.local');
  });
});

describe('mdnsLocalName', () => {
  test('localhost has no usable label', () => {
    expect(mdnsLocalName('localhost')).toBeNull();
  });
  test('already-.local hostname is kept', () => {
    expect(mdnsLocalName('workshop.local')).toBe('workshop.local');
  });
  test('empty hostname is null', () => {
    expect(mdnsLocalName('')).toBeNull();
  });
});

describe('parsers', () => {
  test('parseDefaultRouteInterface picks the lowest-metric default route, not the first interface', () => {
    const table = [
      'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
      'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
      'wg0\t00000000\t00000000\t0001\t0\t0\t900\t00000000\t0\t0\t0',
      'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
    ].join('\n');
    expect(parseDefaultRouteInterface(table)).toBe('wlan0');
    expect(parseDefaultRouteInterface('Iface\tDestination\n')).toBeUndefined();
  });
  test('resolvesToThisHost compares looked-up addresses with this host\'s own', () => {
    const nets = { wlan0: [{ family: 'IPv4', internal: false, address: '192.168.1.20' } as never, { family: 'IPv6', internal: false, address: 'fe80::1%wlan0' } as never] };
    expect(resolvesToThisHost(['192.168.1.20'], nets)).toBe(true);
    expect(resolvesToThisHost(['fe80::1'], nets)).toBe(true);
    expect(resolvesToThisHost(['192.168.1.99'], nets)).toBe(false);
  });
  test('parseTailscaleStatus running with DNSName', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail.ts.net.' } }))).toEqual({ up: true, magicDnsName: 'box.tail.ts.net' });
  });
  test('parseTailscaleStatus stopped', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Stopped', Self: {} }))).toEqual({ up: false });
  });
  test('parseTailscaleStatus invalid json', () => {
    expect(parseTailscaleStatus('not json')).toBeUndefined();
  });
  test('firstNonInternalIpv4 skips internal + IPv6', () => {
    const nets = {
      lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' } as never],
      eth0: [{ family: 'IPv6', internal: false, address: 'fe80::1' } as never, { family: 'IPv4', internal: false, address: '192.168.1.42' } as never],
    };
    expect(firstNonInternalIpv4(nets)).toBe('192.168.1.42');
  });
});

describe('stableUrlHostForBindHost', () => {
  const probe = (): StableHostInputs => ({ hostname: 'workshop', gatewayInterfaceIp: '192.168.1.42', mdnsResolvesToThisHost: true });
  test('wildcard bind resolves through the ladder', () => {
    expect(stableUrlHostForBindHost('0.0.0.0', probe).host).toBe('workshop.local');
    expect(stableUrlHostForBindHost('::', probe).host).toBe('workshop.local');
  });
  test('explicit bind host is honored as-is', () => {
    expect(stableUrlHostForBindHost('10.0.0.9', probe)).toEqual({ host: '10.0.0.9', kind: 'bind-host', stable: false });
  });
  test('loopback stays loopback', () => {
    expect(stableUrlHostForBindHost('127.0.0.1', probe)).toEqual({ host: '127.0.0.1', kind: 'loopback', stable: false });
  });
});

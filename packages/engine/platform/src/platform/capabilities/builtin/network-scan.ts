/**
 * Scanning your local network for model servers (discovery/network-scan.ts):
 * one decision, held by the daemon, and the scan, run by the daemon. Turning it
 * on is the owner's consent to probe the other devices on his network, so a
 * model may read it and turn it off, never on.
 */
import {
  networkScanGranted, networkScanProgress, readNetworkScanConsent, saveNetworkScanConsent, startNetworkScan,
  type NetworkScanHost,
} from '../../discovery/network-scan.js';
import type { DiscoveredServer } from '../../discovery/scanner.js';
import { CapabilityRefusal, type CapabilityDefinition } from '../types.js';

/** What the network-scan capabilities need from the daemon. */
export interface NetworkScanCapabilityServices {
  readonly networkScan: {
    /** The daemon's home (where the decision and the servers found are kept), its sweep and its providers. */
    host(): NetworkScanHost;
    /** The servers the daemon's scans kept. */
    saved(): readonly DiscoveredServer[];
  };
}

type Definition = CapabilityDefinition<NetworkScanCapabilityServices>;

const WHAT = 'Checks the other devices on your local network (your subnet only, nothing beyond it) for model servers such as Ollama or LM Studio, so they can be used as providers.';
const onThisComputer = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1';

export const NETWORK_SCAN_STATUS: Definition = {
  capability: { id: 'network-scan.status', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'status', label: 'See whether your network is scanned for model servers', word: 'status', inputs: [],
  sentence: 'Shows whether the daemon scans your local network for model servers, and the servers it found.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const host = services.networkScan.host();
    const consent = readNetworkScanConsent(host.homeDirectory);
    const progress = networkScanProgress();
    // Each server whole (its address and models), so a program registers the ones on the network as its providers.
    const servers = services.networkScan.saved().map((server) => ({ ...server, network: !onThisComputer(server.host) }));
    const state = consent.kind === 'unreadable' ? 'unreadable' : networkScanGranted(consent) ? 'on' : 'off';
    const lines = [
      state === 'unreadable'
        ? `Scanning your network is off: the decision in ${consent.kind === 'unreadable' ? consent.path : ''} could not be read (${consent.kind === 'unreadable' ? consent.reason : ''}).`
        : state === 'on' ? `Scanning your network is on, since ${consent.kind === 'recorded' ? consent.decidedAt : ''}.` : 'Scanning your network is off.',
      ...(consent.kind === 'recorded' && consent.carried ? ['The decision was carried from the Agent\'s own copy, which is left as it is.'] : []),
      progress.scanning ? 'A scan is running now.' : progress.last ? `The last scan, ${progress.last.at}, ${progress.last.failed ? `failed: ${progress.last.failed}` : `found ${progress.last.found} server${progress.last.found === 1 ? '' : 's'}`}.` : '',
      `${servers.length} model server${servers.length === 1 ? '' : 's'} kept from the daemon's scans.`,
    ].filter(Boolean);
    return {
      text: lines.join('\n'),
      data: {
        state, ...(consent.kind === 'recorded' ? { decidedAt: consent.decidedAt } : {}), ...(consent.kind === 'unreadable' ? { reason: consent.reason } : {}),
        scanning: progress.scanning, ...(progress.last ? { last: progress.last } : {}), servers,
      },
    };
  },
};

export const NETWORK_SCAN_ON: Definition = {
  capability: { id: 'network-scan.on', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'on', label: 'Scan your network for model servers', word: 'on', inputs: [],
  sentence: `${WHAT} The daemon scans now and at each start, until you change it.`, done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'off',
  ownerOnly: { reason: 'it gives consent to probe the other devices on your local network', instead: 'See whether your network is scanned, in the Devices and network place.' },
  example: {},
  async run(_values, services) {
    const host = services.networkScan.host();
    try { saveNetworkScanConsent(host.homeDirectory, 'granted'); } catch (error) {
      throw new CapabilityRefusal(`Not changed: the decision could not be saved (${error instanceof Error ? error.message : String(error)}); scanning stays as it was.`);
    }
    const started = startNetworkScan(host);
    return { text: `Scanning your network is on. ${started ? 'The daemon is scanning now' : 'A scan is already running'}; the servers it finds are listed here when it finishes, and it scans again at each start.`, data: { state: 'on', scanning: true } };
  },
};

export const NETWORK_SCAN_OFF: Definition = {
  capability: { id: 'network-scan.off', group: 'devices', home: 'daemon', repeat: 'safe' },
  actionId: 'off', label: 'Stop scanning your network', word: 'off', inputs: [],
  sentence: 'Nothing on your local network is probed for model servers, until you change it; model servers on this computer are still found.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'on', example: {},
  async run(_values, services) {
    const host = services.networkScan.host();
    try { saveNetworkScanConsent(host.homeDirectory, 'declined'); } catch (error) {
      throw new CapabilityRefusal(`Not changed: the decision could not be saved (${error instanceof Error ? error.message : String(error)}); scanning stays as it was.`);
    }
    return { text: 'Scanning your network is off: nothing on it is probed.', data: { state: 'off' } };
  },
};

export const NETWORK_SCAN_CAPABILITIES: readonly Definition[] = [NETWORK_SCAN_STATUS, NETWORK_SCAN_ON, NETWORK_SCAN_OFF];

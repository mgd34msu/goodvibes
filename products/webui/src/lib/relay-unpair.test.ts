/** Unpairing forgets the relay everywhere; a pairing storage refuses is not silently lost. */
import { afterEach, describe, expect, test } from 'bun:test';
import { getActiveRoute, setActiveRoute, unpairRelay } from './relay-connection';
import {
  RELAY_PAIRING_STORAGE_KEY,
  clearStoredRelayPairing,
  describeRelayPairingForConfirmation,
  getStoredRelayPairing,
  storeRelayPairing,
  type RelayPairingPayload,
} from './relay-pairing';

const PAIRING: RelayPairingPayload = {
  protocol: 1,
  relayUrl: 'wss://relay.example.com/ws',
  rid: 'rid_abc123',
  daemonPublicKey: 'AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDDDDDDD',
};

const realSetItem = Storage.prototype.setItem;

afterEach(() => {
  Storage.prototype.setItem = realSetItem;
  clearStoredRelayPairing();
  setActiveRoute('direct');
});

describe('unpairRelay', () => {
  test('removes the stored pairing and returns the route to direct', () => {
    storeRelayPairing(PAIRING);
    setActiveRoute('relay');
    expect(window.localStorage.getItem(RELAY_PAIRING_STORAGE_KEY)).not.toBeNull();

    unpairRelay();

    expect(window.localStorage.getItem(RELAY_PAIRING_STORAGE_KEY)).toBeNull();
    expect(getStoredRelayPairing()).toBeNull();
    expect(getActiveRoute()).toBe('direct');
  });
});

describe('storeRelayPairing when storage refuses the write', () => {
  test('the pairing still serves this session and unpairing clears it', () => {
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(() => storeRelayPairing(PAIRING)).not.toThrow();
    expect(getStoredRelayPairing()).toEqual(PAIRING);

    unpairRelay();
    expect(getStoredRelayPairing()).toBeNull();
  });
});

describe('describeRelayPairingForConfirmation', () => {
  test('names the relay host and a key fingerprint, and flags a replacement', () => {
    const fresh = describeRelayPairingForConfirmation(PAIRING, null);
    expect(fresh.relayHost).toBe('relay.example.com');
    expect(fresh.fingerprint).toBe('AAAAAAAAAA…DDDDDDDDDD');
    expect(fresh.replacesExisting).toBe(false);

    const other = { ...PAIRING, daemonPublicKey: 'ZZZZZZZZZZYYYYYYYYYYXXXXXXXXXXWWWWWWWWWW' };
    expect(describeRelayPairingForConfirmation(other, PAIRING).replacesExisting).toBe(true);
    expect(describeRelayPairingForConfirmation(PAIRING, PAIRING).replacesExisting).toBe(false);
  });
});

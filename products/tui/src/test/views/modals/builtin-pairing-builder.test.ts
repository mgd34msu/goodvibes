import { expect, test } from 'bun:test';
import { PairingLimitReachedError } from '@goodvibes-jev/engine/platform/platform/pairing';
import { buildPairingConnectionInfo } from '../../../views/builtin-modals.ts';
import type { ResolvedBuiltinViewDeps } from '../../../views/view-deps.ts';
import { createPairingModalSurface } from '../../../views/modals/pairing-modal.ts';
import { ConfigModal } from '../../../input/config-modal.ts';
import { renderConfigModal } from '../../../renderer/config-modal.ts';
import { frameFromLayer } from '../../helpers/surface-frame.ts';

function fixture(throws: boolean | Error = false) {
  let minted = 0;
  const deps = {
    configManager: {
      get: (key: string) => key === 'web.publicBaseUrl' ? 'https://paired.example.test' : key === 'relay.enabled' ? true : undefined,
      setDynamic: () => { throw new Error('existing origin must be preserved'); },
    },
    uiServices: { platform: { pairingTokens: {
      mint: ({ name }: { name: string }) => {
        if (throws) throw throws instanceof Error ? throws : new Error('fixture unavailable');
        minted++;
        return { id: 'fixture-device', name, token: 'fixture-pairing-secret', createdAt: 1 };
      },
    } } },
  } as unknown as ResolvedBuiltinViewDeps;
  return { deps, minted: () => minted };
}

test('real builtin pairing builder produces a handoff and reaches the actual renderer', () => {
  const f = fixture();
  const info = buildPairingConnectionInfo(f.deps);
  expect(info).not.toBeNull();
  expect(f.minted()).toBe(1);
  expect(info?.url).toBe('https://paired.example.test');
  expect(info?.token).toBe('fixture-pairing-secret');
  expect(info?.deepLink).toContain('#pair=');
  expect(info?.offers).toEqual(['notifications', 'relay', 'passkey']);
  const modal = new ConfigModal();
  modal.open(createPairingModalSurface({ getConnectionInfo: () => buildPairingConnectionInfo(f.deps) }));
  const text = frameFromLayer(renderConfigModal(modal, 120, 40), 120, 40).map(line => line.map(cell => cell.char).join('')).join('\n');
  expect(text).toContain('https://paired.example.test');
  expect(text).not.toContain('fixture-pairing-secret');
  expect(text).not.toContain('unavailable');
  modal.close();
});

test('a failing token source reaches the caller as its own error, with nothing minted', () => {
  const f = fixture(true);
  expect(() => buildPairingConnectionInfo(f.deps)).toThrow();
  expect(f.minted()).toBe(0);
});

test('a device-cap refusal reaches the caller with its message instead of collapsing to null', () => {
  const f = fixture(new PairingLimitReachedError(2, 2));
  expect(() => buildPairingConnectionInfo(f.deps)).toThrow('device.nodes.maxPaired is 2');
});

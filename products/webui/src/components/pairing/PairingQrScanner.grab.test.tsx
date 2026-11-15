/**
 * A frame grab that throws (the stream ended between frames) is one missed
 * frame: the scan loop keeps running and the next good frame still decodes.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { ScannedPairing } from '../../lib/pairing-qr';
import type { PairingScannerBindings } from '../../lib/pairing-qr-camera';
import { PairingQrScanner } from './PairingQrScanner';

const realSetImmediate = globalThis.setImmediate;
const COMPANION_JSON = JSON.stringify({ url: 'http://127.0.0.1:3421', token: 'op_tok_grab', username: 'admin', version: '2.0.17', surface: 'daemon' });

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => {
  document.body.innerHTML = '';
  jest.useRealTimers();
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    jest.advanceTimersByTime(0);
    await new Promise<void>((resolve) => realSetImmediate(resolve));
    flushSync(() => {});
  }
}

test('a throwing frame grab does not stop the loop; the next frame decodes', async () => {
  let grabs = 0;
  const tracks = [{ stop() {} }];
  const bindings: PairingScannerBindings = {
    isSecureContext: true,
    mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => tracks } as unknown as MediaStream) } as unknown as MediaDevices,
    createDetector: () => Promise.resolve({ backend: 'jsqr', detect: () => Promise.resolve(COMPANION_JSON) }),
    attachPreview: () => Promise.resolve(),
    grabFrame: () => {
      grabs += 1;
      if (grabs === 1) throw new Error('video is not ready');
      return { data: new Uint8ClampedArray(4), width: 1, height: 1 } as unknown as ImageData;
    },
  };
  const scans: ScannedPairing[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => {
    root.render(React.createElement(PairingQrScanner, { onScanned: (s: ScannedPairing) => scans.push(s), onCancel: () => {}, bindings }));
  });
  await settle();
  expect(grabs).toBe(1);
  expect(scans).toHaveLength(0);
  jest.advanceTimersByTime(180);
  await settle();
  expect(scans).toHaveLength(1);
  flushSync(() => root.unmount());
});

import { afterEach, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

const starts: number[] = [];
const connectedState = { status: 'connected', message: 'Connected', announced: [], activity: [] };

class FakePhoneNodeClient {
  getState() { return connectedState; }
  start() { starts.push(1); }
  stop() {}
}

mock.module('../../lib/goodvibes', () => ({ GOODVIBES_BASE_URL: 'http://localhost' }));
mock.module('../../lib/device-node/phone-node-client', () => ({
  PhoneNodeClient: FakePhoneNodeClient,
  browserPhoneNodeStorage: () => ({}),
}));
mock.module('../../components/settings/DeviceGrants', () => ({ DeviceGrants: () => null }));

const { PhoneNodeView } = await import('./PhoneNodeView');
const cleanups: (() => void)[] = [];
afterEach(() => { starts.length = 0; for (const clean of cleanups.splice(0)) clean(); });

test('opening the view for an already connected phone starts its client once', async () => {
  const el = document.createElement('div'); document.body.append(el);
  const root = createRoot(el);
  cleanups.push(() => { flushSync(() => root.unmount()); el.remove(); });
  flushSync(() => root.render(<PhoneNodeView />));
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(el.textContent).toContain('Connected');
  expect(starts).toHaveLength(1);
});

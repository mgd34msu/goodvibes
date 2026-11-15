import { afterEach, expect, test } from 'bun:test';
import { invalidateClientLifetime } from '../client-lifetime';
import { readInstallPlatform, type InstallPlatformInput } from './platform-judgment';

const ipad = (): InstallPlatformInput => ({ userAgent: 'Macintosh synthetic iPad', platform: 'MacIntel', maxTouchPoints: 5 });
afterEach(() => invalidateClientLifetime());

test('platform instructions need no transport and survive an unrelated host replacement', async () => {
  const result = await readInstallPlatform(ipad(), new AbortController().signal);
  expect(result.status).toBe('ready'); if (result.status !== 'ready') throw new Error('Missing local platform');
  expect(result.platform).toBe('ios-share-menu');
  invalidateClientLifetime(); expect(result.isCurrent()).toBe(true);
});
test('cancellation and changed browser metadata expire local platform facts', async () => {
  const input = ipad(); const abort = new AbortController();
  const result = await readInstallPlatform(input, abort.signal);
  if (result.status !== 'ready') throw new Error('Missing local platform');
  Object.assign(input, { platform: 'Linux x86_64' }); expect(result.isCurrent()).toBe(false);
  abort.abort(); expect(await readInstallPlatform(ipad(), abort.signal)).toEqual({ status: 'held' });
});
test('desktop Mac and Android do not get iOS instructions', async () => {
  for (const input of [{ userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 0 }, { userAgent: 'Android', platform: 'Linux aarch64', maxTouchPoints: 5 }]) {
    const result = await readInstallPlatform(input, new AbortController().signal);
    expect(result.status === 'ready' && result.platform).toBe('other');
  }
});

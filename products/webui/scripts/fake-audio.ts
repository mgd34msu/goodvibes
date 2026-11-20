/**
 * A fake AudioContext for the connected router smoke: the Web Audio player runs
 * with no real decoding or audio hardware.
 */
import type { Page } from '@playwright/test';

/** Inject a fake AudioContext so the Web Audio player runs deterministically with no real
 * decoding or hardware. decodeAudioData always resolves; a scheduled source "ends" after a
 * generous delay so the playing/Stop state is observable and interruptible. */
export async function installFakeAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      decodeAudioData() {
        return Promise.resolve({ duration: 1.5 });
      }
      createBufferSource() {
        const source: {
          buffer: unknown;
          onended: (() => void) | null;
          connect: () => void;
          start: () => void;
          stop: () => void;
        } = {
          buffer: null,
          onended: null,
          connect: () => undefined,
          start: () => {
            setTimeout(() => source.onended?.(), 1500);
          },
          stop: () => {
            source.onended = null;
          },
        };
        return source;
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim
    (window as any).AudioContext = FakeAudioContext;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test shim
    (window as any).webkitAudioContext = FakeAudioContext;
  });
}

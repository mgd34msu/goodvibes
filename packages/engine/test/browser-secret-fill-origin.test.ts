import { describe, expect, test } from 'bun:test';
import type { Locator } from 'playwright-core';
import { sameOriginAsPage } from '../platform/src/platform/browser/browser-secret-fill.js';

const PAGE = 'https://merchant.example/checkout';
const work = { action: <T>(perform: (signal: AbortSignal) => Promise<T>) => perform(new AbortController().signal) };

function framed(origin: string | Error, frameChain: readonly string[] = ['frame-1']) {
  let asked = 0;
  const locator = { evaluate: async () => { asked++; if (origin instanceof Error) throw origin; return origin; } } as unknown as Pick<Locator, 'evaluate'>;
  return { item: { kind: 'number' as const, locator, element: { frameChain } }, asked: () => asked };
}

describe('card material and the document it is typed into', () => {
  test('a control in a frame from another origin is refused', async () => {
    const f = framed('https://ads.example');
    expect(await sameOriginAsPage(f.item, PAGE, 1000, work)).toBe(false);
  });

  test('a control in a frame from the merchant origin is accepted', async () => {
    const f = framed('https://merchant.example');
    expect(await sameOriginAsPage(f.item, PAGE, 1000, work)).toBe(true);
  });

  test('a frame whose origin cannot be read is refused', async () => {
    const f = framed(new Error('detached'));
    expect(await sameOriginAsPage(f.item, PAGE, 1000, work)).toBe(false);
  });

  test('a control in the page itself is accepted without asking the document', async () => {
    const f = framed('https://ads.example', []);
    expect(await sameOriginAsPage(f.item, PAGE, 1000, work)).toBe(true);
    expect(f.asked()).toBe(0);
  });
});

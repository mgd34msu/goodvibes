import { expect, test } from 'bun:test';
import { AddressRateLimiter } from '../daemon-api/src/relay-server.js';

test('the limiter remembers a bounded number of addresses however many probe it', () => {
  const limiter = new AddressRateLimiter(5, 100);
  for (let i = 0; i < 5_000; i++) limiter.allow(`10.0.${i >> 8}.${i & 255}`, 1_000);
  expect(limiter.trackedAddresses).toBeLessThanOrEqual(100);
});

test('addresses whose attempts have aged out are dropped first, and a busy address keeps its limit', () => {
  const limiter = new AddressRateLimiter(2, 10);
  for (let i = 0; i < 10; i++) limiter.allow(`old-${i}`, 0);
  expect(limiter.allow('busy', 100_000)).toBe(true);
  expect(limiter.allow('busy', 100_001)).toBe(true);
  for (let i = 0; i < 5; i++) limiter.allow(`new-${i}`, 100_002);
  expect(limiter.trackedAddresses).toBeLessThanOrEqual(10);
  expect(limiter.allow('busy', 100_003)).toBe(false);
});

test('an address is allowed again once its attempts leave the one-minute window', () => {
  const limiter = new AddressRateLimiter(1, 10);
  expect(limiter.allow('a', 0)).toBe(true);
  expect(limiter.allow('a', 59_999)).toBe(false);
  expect(limiter.allow('a', 60_001)).toBe(true);
});

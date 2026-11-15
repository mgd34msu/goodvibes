import { describe, expect, test } from 'bun:test';
import { createBrowserTokenStore, createMemoryTokenStore } from '../platform/src/auth.js';
import {
  createNativeTokenPersistence,
  type NativeTokenStorage,
} from '../platform/src/client-auth/native-token-persistence.js';

function memoryStorage(): Storage & { readonly writes: string[] } {
  const items = new Map<string, string>();
  const writes: string[] = [];
  return {
    writes,
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => { items.delete(key); writes.push(`remove:${key}`); },
    setItem: (key, value) => { items.set(key, value); writes.push(`set:${key}`); },
  };
}

describe('every token store treats a blank token as no token', () => {
  test('memory store', async () => {
    const store = createMemoryTokenStore();
    await store.setTokenEntry!('   ', 5);
    expect(await store.getTokenEntry!()).toEqual({ token: null });
    await store.setTokenEntry!('  abc  ', 5);
    expect(await store.getTokenEntry!()).toEqual({ token: 'abc', expiresAt: 5 });
  });

  test('browser store', async () => {
    const storage = memoryStorage();
    const store = createBrowserTokenStore({ storage });
    await store.setTokenEntry!('abc', 5);
    await store.setTokenEntry!('   ', 9);
    expect(await store.getToken()).toBeNull();
    expect(storage.length).toBe(0);
    storage.setItem('goodvibes.token', '   ');
    expect(await store.getToken()).toBeNull();
  });

  test('native persistence stores a blank token as a clear and a padded one trimmed', async () => {
    let stored: string | null = null;
    const native: NativeTokenStorage = {
      read: async () => stored,
      write: async (value) => { stored = value; },
      remove: async () => { stored = null; },
    };
    const { readPayload, writePayload } = createNativeTokenPersistence(async () => native, 'test store');
    await writePayload({ token: '  abc ', expiresAt: 7 });
    expect(await readPayload()).toEqual({ token: 'abc', expiresAt: 7 });
    await writePayload({ token: '   ', expiresAt: 7 });
    expect(await readPayload()).toBeNull();
  });

  test('native persistence reads a stored blank token as none and clears a corrupt payload', async () => {
    let stored: string | null = JSON.stringify({ token: '  ', expiresAt: 3 });
    const native: NativeTokenStorage = {
      read: async () => stored,
      write: async (value) => { stored = value; },
      remove: async () => { stored = null; },
    };
    const { readPayload } = createNativeTokenPersistence(async () => native, 'test store');
    expect(await readPayload()).toEqual({ token: null, expiresAt: null });
    stored = '{not json';
    await expect(readPayload()).rejects.toThrow('corrupt and was cleared');
    expect(stored).toBeNull();
  });
});

describe('browser store entry writes', () => {
  test('the expiry is written before the token, so no reader pairs a new token with the old expiry', async () => {
    const storage = memoryStorage();
    const store = createBrowserTokenStore({ storage });
    await store.setTokenEntry!('abc', 5);
    expect(storage.writes).toEqual(['set:goodvibes.token.expiresAt', 'set:goodvibes.token']);
  });

  test('a token set without an expiry drops the old expiry before the token changes', async () => {
    const storage = memoryStorage();
    const store = createBrowserTokenStore({ storage });
    await store.setTokenEntry!('abc', 5);
    storage.writes.length = 0;
    await store.setToken('next');
    expect(storage.writes).toEqual(['remove:goodvibes.token.expiresAt', 'set:goodvibes.token']);
  });
});

describe('a token given at construction follows the same rule', () => {
  test('memory store drops a blank initial token and its expiry, and trims a padded one', async () => {
    expect(await createMemoryTokenStore('   ', 5).getTokenEntry!()).toEqual({ token: null });
    expect(await createMemoryTokenStore('  tok\n', 5).getToken()).toBe('tok');
  });
});

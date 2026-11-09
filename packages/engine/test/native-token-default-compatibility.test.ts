import { expect, test } from 'bun:test';
import { createExpoSecureTokenStore } from '../platform/src/client-auth/expo-secure-token-store.js';
import { createIOSKeychainTokenStore } from '../platform/src/client-auth/ios-keychain-token-store.js';
import { createAndroidKeystoreTokenStore } from '../platform/src/client-auth/android-keystore-token-store.js';

// Only real deployed default addresses occur in these saved native-data
// fixtures. No compatibility export, package alias or new old-address writer.
type Adapter = 'expo' | 'ios' | 'android';
interface Selection { readonly key?: string; readonly service?: string; readonly keychainService?: string; readonly accessGroup?: string }
interface NativeOptions { readonly service?: string; readonly keychainService?: string; readonly accessGroup?: string }
function fixture(adapter: Adapter) {
  const canonical = adapter === 'expo' ? 'goodvibes-platform-token' : 'com.goodvibes.platform';
  const previous = adapter === 'expo' ? 'goodvibes-sdk-token' : 'com.pellux.goodvibes-sdk';
  const values = new Map<string, string>(), calls: { kind: 'read' | 'write' | 'remove'; key: string; scope: string }[] = [];
  const faults: { read?: string | undefined; write?: boolean | undefined; writeAfterEffect?: boolean | undefined; remove?: string | undefined; falseWrite?: boolean | undefined; falseRemove?: string | undefined; pauseRead?: { key: string; entered(): void; gate: Promise<void> } | undefined } = {};
  const address = (key: string, scope = '') => JSON.stringify([scope, key]);
  const scope = (options?: NativeOptions) => adapter === 'expo' ? options?.keychainService ?? '' : options?.accessGroup ?? '';
  async function read(key: string, options?: NativeOptions): Promise<string | null> {
    const selectedScope = scope(options); calls.push({ kind: 'read', key, scope: selectedScope });
    if (faults.read === key) throw Error('Native read refused');
    const value = values.get(address(key, selectedScope)) ?? null;
    if (faults.pauseRead?.key === key) { const pause = faults.pauseRead; faults.pauseRead = undefined; pause.entered(); await pause.gate; }
    return value;
  }
  async function write(key: string, value: string, options?: NativeOptions): Promise<void> {
    const selectedScope = scope(options); calls.push({ kind: 'write', key, scope: selectedScope });
    if (faults.write) throw Error('Native write refused');
    values.set(address(key, selectedScope), value);
    if (faults.writeAfterEffect) throw Error('Native acknowledgment lost');
  }
  async function remove(key: string, options?: NativeOptions): Promise<void> {
    const selectedScope = scope(options); calls.push({ kind: 'remove', key, scope: selectedScope });
    if (faults.remove === key) throw Error('Native delete refused');
    values.delete(address(key, selectedScope));
  }
  const module = {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
    ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'unlocked' }, ACCESS_CONTROL: {},
    getItemAsync: read, setItemAsync: write, deleteItemAsync: remove,
    async getGenericPassword(options?: NativeOptions) {
      const key = options?.service ?? '', password = await read(key, options);
      return password === null ? false as const : { username: 'saved-native-owner', password, service: key, storage: 'native' };
    },
    async setGenericPassword(_username: string, password: string, options?: NativeOptions) {
      if (faults.falseWrite) return false as const;
      const key = options?.service ?? ''; await write(key, password, options); return { service: key, storage: 'native' };
    },
    async resetGenericPassword(options?: NativeOptions) {
      const key = options?.service ?? ''; if (faults.falseRemove === key) return false;
      await remove(key, options); return true;
    },
  };
  const loader = async () => module;
  const create = (selection: Selection = {}) => {
    if (adapter === 'expo') return createExpoSecureTokenStore(selection, loader);
    if (adapter === 'ios') return createIOSKeychainTokenStore(selection, loader);
    return createAndroidKeystoreTokenStore(selection, loader);
  };
  const put = (key: string, token: string, expiresAt: number | null = null, selectedScope = '') => values.set(address(key, selectedScope), JSON.stringify({ token, expiresAt }));
  return { adapter, canonical, previous, values, calls, faults, address, create, put };
}

for (const adapter of ['expo', 'ios', 'android'] as const) {
  test(`${adapter}: default read preserves the deployed token/expiry without automatic migration`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'saved-bearer', 1_900_000_000_000);
    expect(await f.create().getTokenEntry()).toEqual({ token: 'saved-bearer', expiresAt: 1_900_000_000_000 });
    expect(f.calls.filter(call => call.kind !== 'read')).toEqual([]);
    expect(f.values.has(f.address(f.canonical))).toBe(false); expect(f.values.has(f.address(f.previous))).toBe(true);
  });

  test(`${adapter}: rotation writes the canonical token before retiring the exact earlier entry`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'earlier-bearer'); const store = f.create();
    await store.setTokenEntry('current-bearer', 1_950_000_000_000);
    expect(await f.create().getTokenEntry()).toEqual({ token: 'current-bearer', expiresAt: 1_950_000_000_000 });
    expect(f.values.has(f.address(f.previous))).toBe(false);
    const effects = f.calls.filter(call => call.kind !== 'read');
    expect(effects.map(call => [call.kind, call.key])).toEqual([['write', f.canonical], ['remove', f.previous]]);
  });

  test(`${adapter}: interrupted old-entry deletion cannot resurrect the bearer after clear or reopen`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'earlier-bearer'); f.faults.remove = f.previous;
    await expect(f.create().clearToken()).rejects.toMatchObject({ code: 'ENGINE_TOKEN_STORE_CLEANUP_FAILED' });
    expect(f.values.has(f.address(f.previous))).toBe(true);
    expect(JSON.parse(f.values.get(f.address(f.canonical))!)).toEqual({ token: null, expiresAt: null });
    expect(await f.create().getToken()).toBeNull();
    f.faults.remove = undefined; await f.create().clearToken();
    expect(f.values.has(f.address(f.previous))).toBe(false); expect(await f.create().getToken()).toBeNull();
  });

  test(`${adapter}: partial rotation remains canonical and reports the incomplete cleanup`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'earlier-bearer'); f.faults.remove = f.previous;
    await expect(f.create().setToken('current-bearer')).rejects.toMatchObject({ code: 'ENGINE_TOKEN_STORE_CLEANUP_FAILED' });
    expect(await f.create().getToken()).toBe('current-bearer');
    expect(f.values.has(f.address(f.previous))).toBe(true);
  });

  test(`${adapter}: failed canonical write never deletes the earlier credential`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'saved-bearer'); f.faults.write = true; const store = f.create();
    await expect(store.clearToken()).rejects.toMatchObject({ code: 'ENGINE_TOKEN_STORE_WRITE_FAILED' });
    expect(f.values.has(f.address(f.canonical))).toBe(false); expect(f.values.has(f.address(f.previous))).toBe(true);
    expect(f.calls.filter(call => call.kind === 'remove')).toEqual([]);
    expect(await store.getToken()).toBe('saved-bearer');
    f.faults.write = false; await store.setToken('retried-bearer'); expect(await store.getToken()).toBe('retried-bearer');
  });

  test(`${adapter}: an unconfirmed entered write is reported honestly without reviving the older default`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'earlier-bearer'); f.faults.writeAfterEffect = true;
    await expect(f.create().setToken('current-bearer')).rejects.toMatchObject({ code: 'ENGINE_TOKEN_STORE_WRITE_FAILED' });
    expect(await f.create().getToken()).toBe('current-bearer');
    expect(f.calls.filter(call => call.kind === 'remove')).toEqual([]);
  });

  test(`${adapter}: canonical read failure does not fall back to an older bearer`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'earlier-bearer'); f.faults.read = f.canonical;
    await expect(f.create().getToken()).rejects.toThrow('Native read refused');
    expect(f.calls.some(call => call.key === f.previous)).toBe(false);
  });

  test(`${adapter}: a corrupt canonical entry clears the earlier default instead of exposing it on the next read`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'earlier-bearer'); f.values.set(f.address(f.canonical), '{private-bearer-content');
    await expect(f.create().getToken()).rejects.toMatchObject({ code: 'ENGINE_TOKEN_STORE_CORRUPT' });
    expect(await f.create().getToken()).toBeNull(); expect(f.values.has(f.address(f.previous))).toBe(false);
  });

  test(`${adapter}: corrupt earlier data leaves an authoritative clear without exposing parser content`, async () => {
    const f = fixture(adapter); f.values.set(f.address(f.previous), '{private-bearer-content');
    const error: unknown = await f.create().getToken().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'ENGINE_TOKEN_STORE_CORRUPT' });
    expect(String(error)).not.toContain('private-bearer-content');
    expect(await f.create().getToken()).toBeNull();
  });

  for (const malformed of [JSON.stringify('not-a-token-record'), JSON.stringify({ token: { private: 'hidden' } }), JSON.stringify({ token: 'saved', expiresAt: 'tomorrow' })]) {
    test(`${adapter}: malformed native token record ${malformed.length} cannot escape as a credential`, async () => {
      const f = fixture(adapter); f.values.set(f.address(f.canonical), malformed); f.put(f.previous, 'earlier-bearer');
      await expect(f.create().getToken()).rejects.toMatchObject({ code: 'ENGINE_TOKEN_STORE_CORRUPT' });
      expect(await f.create().getToken()).toBeNull();
    });
  }

  for (const empty of ['', 'null']) test(`${adapter}: existing canonical clear representation ${JSON.stringify(empty)} suppresses old fallback`, async () => {
    const f = fixture(adapter); f.values.set(f.address(f.canonical), empty); f.put(f.previous, 'earlier-bearer');
    expect(await f.create().getToken()).toBeNull();
    expect(f.calls.some(call => call.key === f.previous)).toBe(false);
  });

  test(`${adapter}: explicit custom namespaces never read or delete the earlier default`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'default-bearer');
    const custom = adapter === 'expo' ? { key: 'private-token' } : { service: 'com.app.private-token' };
    const key = adapter === 'expo' ? custom.key! : custom.service!; f.put(key, 'private-saved-bearer');
    const store = f.create(custom); expect(await store.getToken()).toBe('private-saved-bearer');
    await store.setToken('private-current'); await store.clearToken(); expect(await store.getToken()).toBeNull();
    expect(f.calls.some(call => call.key === f.previous || call.key === f.canonical)).toBe(false);
    expect(f.values.has(f.address(f.previous))).toBe(true);
  });

  test(`${adapter}: original custom selector is captured once and a changing getter cannot enable old fallback`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'foreign-default'); f.put('private-address', 'selected-private');
    let reads = 0;
    const options = Object.defineProperty({}, adapter === 'expo' ? 'key' : 'service', { get() { reads++; return reads === 1 ? 'private-address' : undefined; } });
    const store = f.create(options); expect(await store.getToken()).toBe('selected-private');
    expect(reads).toBe(1); expect(f.calls.some(call => call.key === f.previous)).toBe(false);
  });

  test(`${adapter}: explicitly supplied canonical address never adopts old defaults and clear still prevents fallback`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'earlier-bearer');
    const store = f.create(adapter === 'expo' ? { key: f.canonical } : { service: f.canonical });
    expect(await store.getToken()).toBeNull();
    await store.clearToken();
    expect(f.calls.some(call => call.key === f.previous)).toBe(false);
    expect(f.values.has(f.address(f.previous))).toBe(true);
    expect(await f.create().getToken()).toBeNull();
  });

  test(`${adapter}: clear waits for an already admitted fallback read and no later read revives it`, async () => {
    const f = fixture(adapter); f.put(f.previous, 'earlier-bearer');
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.faults.pauseRead = { key: f.previous, entered: enter, gate };
    const store = f.create(), read = store.getToken(); await entered;
    const clear = store.clearToken();
    try { await Promise.resolve(); expect(f.calls.filter(call => call.kind !== 'read')).toEqual([]); }
    finally { release(); await Promise.allSettled([read, clear]); }
    expect(await read).toBe('earlier-bearer'); await clear;
    expect(await store.getToken()).toBeNull(); expect(await f.create().getToken()).toBeNull();
  });

  if (adapter !== 'expo') {
    test(`${adapter}: false native write is not a success acknowledgment and preserves the earlier entry`, async () => {
      const f = fixture(adapter); f.put(f.previous, 'saved-bearer'); f.faults.falseWrite = true;
      await expect(f.create().setToken('new-bearer')).rejects.toMatchObject({ code: 'ENGINE_TOKEN_STORE_WRITE_FAILED' });
      expect(f.values.has(f.address(f.canonical))).toBe(false); expect(await f.create().getToken()).toBe('saved-bearer');
    });
    test(`${adapter}: false native delete with retained old data reports partial cleanup without resurrection`, async () => {
      const f = fixture(adapter); f.put(f.previous, 'saved-bearer'); f.faults.falseRemove = f.previous;
      await expect(f.create().clearToken()).rejects.toMatchObject({ code: 'ENGINE_TOKEN_STORE_CLEANUP_FAILED' });
      expect(f.values.has(f.address(f.previous))).toBe(true); expect(await f.create().getToken()).toBeNull();
    });
  }
}

test('Expo default compatibility remains within the original keychain service', async () => {
  const f = fixture('expo'); f.put(f.previous, 'foreign-service-bearer'); f.put(f.previous, 'selected-service-bearer', null, 'private-service');
  const store = f.create({ keychainService: 'private-service' }); expect(await store.getToken()).toBe('selected-service-bearer');
  await store.clearToken(); expect(f.values.has(f.address(f.previous))).toBe(true);
  expect(f.calls.every(call => call.scope === 'private-service')).toBe(true);
});

test('iOS default compatibility remains within the original keychain access group', async () => {
  const f = fixture('ios'); f.put(f.previous, 'foreign-group-bearer'); f.put(f.previous, 'selected-group-bearer', null, 'private-group');
  const store = f.create({ accessGroup: 'private-group' }); expect(await store.getToken()).toBe('selected-group-bearer');
  await store.clearToken(); expect(f.values.has(f.address(f.previous))).toBe(true);
  expect(f.calls.every(call => call.scope === 'private-group')).toBe(true);
});

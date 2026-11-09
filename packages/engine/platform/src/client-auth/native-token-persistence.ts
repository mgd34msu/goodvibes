import { GoodVibesError } from '@goodvibes-jev/engine/errors';

export interface NativeTokenPayload {
  readonly token: string | null;
  readonly expiresAt: number | null;
}

/** One actual native module and the original selected key/service per operation. */
export interface NativeTokenStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
  /** The selected address is the canonical default even if explicitly supplied.
   * A clear must suppress an omitted-options reader's older fallback. */
  readonly clearBarrier?: boolean;
  /** Only an omitted default namespace has an earlier deployed address. */
  readonly previous?: {
    read(): Promise<string | null>;
    remove(): Promise<void>;
  };
}

function failure(label: string, code: string, detail: string): GoodVibesError {
  return new GoodVibesError(`${label}: ${detail}`, {
    code, category: 'authentication', source: 'runtime', recoverable: true,
  });
}

/** Shared only by the three hardware-backed token adapters. Valid reads do not
 * migrate data. Default clear writes a durable empty canonical entry before
 * deleting the earlier entry: an interrupted/failed cleanup must never make a
 * subsequent read fall back to an older bearer. Explicit custom namespaces
 * have no previous entry; distinct custom addresses retain single-entry removal.
 */
export function createNativeTokenPersistence(resolve: () => Promise<NativeTokenStorage>, label: string): {
  readPayload(): Promise<NativeTokenPayload | null>;
  writePayload(payload: NativeTokenPayload | null): Promise<void>;
} {
  // Order read/fallback, rotation and clear on this actual store instance. No
  // token or previous native module is cached between operations.
  let tail = Promise.resolve();
  function operation<T>(run: (storage: NativeTokenStorage) => Promise<T>): Promise<T> {
    const result = tail.then(async () => run(await resolve()));
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function publish(storage: NativeTokenStorage, payload: NativeTokenPayload | null): Promise<void> {
    if (payload === null && !storage.previous && !storage.clearBarrier) {
      try { await storage.remove(); }
      catch { throw failure(label, 'ENGINE_TOKEN_STORE_CLEAR_FAILED', 'clearing could not be confirmed; saved credentials may remain. Retry clearing the token.'); }
      return;
    }
    // The null-token entry is an explicit clear, distinct from an address that
    // has never been written. It stays authoritative across process restarts.
    const encoded = JSON.stringify(payload ?? { token: null, expiresAt: null });
    try { await storage.write(encoded); }
    catch { throw failure(label, 'ENGINE_TOKEN_STORE_WRITE_FAILED', 'writing could not be confirmed; saved credentials may have changed. Retry the token update or clear.'); }
    if (storage.previous) {
      try { await storage.previous.remove(); }
      catch { throw failure(label, 'ENGINE_TOKEN_STORE_CLEANUP_FAILED', 'the canonical value was saved, but the earlier default entry could not be removed. Retry the token update or clear.'); }
    }
  }

  return {
    readPayload: () => operation(async storage => {
      // Presence, including an empty canonical entry, always wins over an old
      // default value. A failed canonical read never authorizes old fallback.
      const canonical = await storage.read();
      const raw = canonical === null && storage.previous ? await storage.previous.read() : canonical;
      if (raw === null || raw === '') return null;
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw) as unknown;
        if (decoded === null) return null;
        if (typeof decoded !== 'object' || Array.isArray(decoded) || !Object.hasOwn(decoded, 'token')) throw Error();
        const record = decoded as Record<string, unknown>, token = record['token'], expiresAt = record['expiresAt'];
        if (token !== null && typeof token !== 'string') throw Error();
        if (expiresAt !== undefined && expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) throw Error();
        return { token, expiresAt: typeof expiresAt === 'number' ? expiresAt : null };
      } catch {
        await publish(storage, null);
        // Do not retain a JSON.parse error that can echo credential bytes.
        throw failure(label, 'ENGINE_TOKEN_STORE_CORRUPT', 'the stored payload is corrupt and was cleared.');
      }
    }),
    writePayload: payload => operation(storage => publish(storage, payload)),
  };
}

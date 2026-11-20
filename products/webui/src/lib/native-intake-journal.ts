import {
  nativeConversationIntakeCaptureRequestSchema,
  type NativeConversationIntakeCaptureRequest,
} from "@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-intake-client";

/** Public authority only. Never include a bearer token or relay rendezvous credential. */
export interface NativeIntakeBrowserBinding {
  endpoint: string;
  projectId: string;
  principalId: string;
  /** `direct` or `relay:<daemon public key>`; the authenticated owner supplies this. */
  transport: string;
}

export interface NativeIntakeBrowserRecord {
  binding: NativeIntakeBrowserBinding;
  command: NativeConversationIntakeCaptureRequest;
  createdAt: number;
}

export interface NativeIntakeBrowserJournal {
  list(binding: NativeIntakeBrowserBinding): Promise<NativeIntakeBrowserRecord[]>;
  save(record: NativeIntakeBrowserRecord): Promise<void>;
  /** Confirm the exact persisted original immediately before replay. This never removes it. */
  confirm(record: NativeIntakeBrowserRecord): Promise<void>;
  /**
   * Retire one exact original. Only for a request whose daemon state is settled (see
   * `release` in native-intake.ts); the journal itself never decides that and never evicts.
   */
  remove(record: NativeIntakeBrowserRecord): Promise<void>;
  /** How many stored records could not be read (damaged, or written by another build). They are kept until discarded. */
  unreadable(): Promise<number>;
  /**
   * How many records of the same daemon and project were saved under another paired
   * principal (this browser paired again). Only the count leaves the store: their text
   * belongs to that principal, who sees them by signing in as that pairing.
   */
  countOthers(binding: NativeIntakeBrowserBinding): Promise<number>;
  /** Delete every record that cannot be read. Returns how many were deleted. */
  discardUnreadable(): Promise<number>;
}

export const NATIVE_INTAKE_BROWSER_JOURNAL_DATABASE = "goodvibes.native-intake.v1";
export const NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS = 128;
export const NATIVE_INTAKE_BROWSER_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
const STORE = "captures";
const BINDING_KEYS = ["endpoint", "projectId", "principalId", "transport"];
const KEY_PATH = [...BINDING_KEYS.map((key) => `binding.${key}`), "command.inputId"];
const REQUEST_KEY_PATH = [...BINDING_KEYS.map((key) => `binding.${key}`), "command.requestId"];

export class NativeIntakeBrowserJournalError extends Error {
  constructor(
    readonly code:
      | "invalid-record"
      | "unavailable"
      | "durability"
      | "corrupt"
      | "conflict"
      | "missing"
      | "capacity"
  ) {
    super(
      code === "capacity"
        ? `Native intake source journal: capacity. This browser keeps at most ${NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS} saved requests. Release a request the daemon reports as finished to make room; unfinished originals are never discarded.`
        : `Native intake source journal: ${code}. Original source must be durably retained before sending.`
    );
    this.name = "NativeIntakeBrowserJournalError";
  }
}

/** Refuse hidden fields and accessors as well as ordinary unknown JSON keys. */
function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === "string" &&
        keys.includes(key) &&
        descriptor !== undefined &&
        "value" in descriptor
      );
    })
  );
}

function bindingSnapshot(value: unknown): NativeIntakeBrowserBinding {
  if (!exactObject(value, BINDING_KEYS))
    throw new NativeIntakeBrowserJournalError("invalid-record");
  const { endpoint, projectId, principalId, transport } = value;
  if (
    typeof endpoint !== "string" ||
    endpoint.length > 2048 ||
    endpoint.trim() !== endpoint ||
    typeof projectId !== "string" ||
    !projectId.trim() ||
    projectId.length > 200 ||
    typeof principalId !== "string" ||
    !principalId.trim() ||
    principalId.length > 200 ||
    typeof transport !== "string" ||
    !/^(?:direct|relay:[A-Za-z0-9_-]{1,200})$/.test(transport)
  ) {
    throw new NativeIntakeBrowserJournalError("invalid-record");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new NativeIntakeBrowserJournalError("invalid-record");
  }
  // Endpoint authentication must remain in the live transport, never this journal.
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new NativeIntakeBrowserJournalError("invalid-record");
  }
  return { endpoint, projectId, principalId, transport };
}

function continuationSnapshotShape(value: unknown): boolean {
  if (exactObject(value, ["sessionId"])) return true;
  if (!exactObject(value, ["sessionId", "selectedDiff"])) return false;
  return exactObject(value.selectedDiff, ["kind", "revision", "fileIndex", "hunkIndex"]) ||
    exactObject(value.selectedDiff, ["kind", "baselineId", "revision", "fileIndex", "hunkIndex"]);
}

function recordSnapshot(value: unknown): NativeIntakeBrowserRecord {
  if (
    !exactObject(value, ["binding", "command", "createdAt"]) ||
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    !(
      exactObject(value.command, ["requestId", "inputId", "text", "unsupportedSources"]) ||
      (exactObject(value.command, [
        "requestId",
        "inputId",
        "text",
        "unsupportedSources",
        "continuation",
      ]) &&
        continuationSnapshotShape(value.command.continuation))
    ) ||
    !Array.isArray(value.command.unsupportedSources) ||
    value.command.unsupportedSources.length > 100 ||
    !value.command.unsupportedSources.every((marker: unknown) =>
      exactObject(marker, ["kind", "label"])
    )
  ) {
    throw new NativeIntakeBrowserJournalError("invalid-record");
  }
  const parsed = nativeConversationIntakeCaptureRequestSchema.safeParse(value.command);
  if (!parsed.success) throw new NativeIntakeBrowserJournalError("invalid-record");
  return {
    binding: bindingSnapshot(value.binding),
    command: parsed.data,
    createdAt: value.createdAt,
  };
}

/**
 * Who owns a saved record: the daemon, its project and the paired principal. The transport is
 * how the daemon was reached (direct or through the relay), not who owns the request, so a
 * request saved on the local network stays visible and actionable after a switch to the relay.
 */
function sameBinding(left: NativeIntakeBrowserBinding, right: NativeIntakeBrowserBinding): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.projectId === right.projectId &&
    left.principalId === right.principalId
  );
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * A record that fails the current strict shape (damaged, or written by another build) is
 * skipped and counted, never allowed to make every other saved original unreadable or to
 * block saving a new one. It stays in the store untouched.
 */
function readRecords(values: unknown[]): { records: NativeIntakeBrowserRecord[]; unreadable: number } {
  const records: NativeIntakeBrowserRecord[] = [];
  let unreadable = 0;
  for (const value of values) {
    try {
      records.push(recordSnapshot(value));
    } catch {
      unreadable += 1;
    }
  }
  if (
    records.length > NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS ||
    records.reduce((total, record) => total + encodedBytes(record), 0) >
      NATIVE_INTAKE_BROWSER_JOURNAL_MAX_BYTES
  ) {
    throw new NativeIntakeBrowserJournalError("capacity");
  }
  return { records, unreadable };
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      settled = true;
      reject(new NativeIntakeBrowserJournalError("unavailable"));
    };
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, 1);
    } catch {
      fail();
      return;
    }
    request.onerror = fail;
    request.onblocked = fail;
    request.onupgradeneeded = () => {
      try {
        // There is no migration that drops, replaces, or evicts captured originals.
        const store = request.result.createObjectStore(STORE, { keyPath: KEY_PATH });
        store.createIndex("request", REQUEST_KEY_PATH, { unique: true });
      } catch {
        request.transaction?.abort();
        fail();
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      database.onversionchange = () => {
        database.close();
      };
      settled = true;
      resolve(database);
    };
  });
}

/**
 * No localStorage fallback: read/validate/add share one cross-tab serialized transaction.
 * Only strict transaction completion acknowledges durability, never request.onsuccess.
 * Browsers may still lose user-cleared site data; no browser API can prevent that.
 */
export function createNativeIntakeBrowserJournal(
  options: {
    indexedDB?: IDBFactory;
    databaseName?: string;
  } = {}
): NativeIntakeBrowserJournal {
  async function transaction<T>(
    operate: (records: NativeIntakeBrowserRecord[], store: IDBObjectStore, unreadable: number) => T
  ): Promise<T> {
    let factory: IDBFactory | undefined;
    try {
      factory = options.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    } catch {
      throw new NativeIntakeBrowserJournalError("unavailable");
    }
    if (!factory) throw new NativeIntakeBrowserJournalError("unavailable");
    const database = await openDatabase(
      factory,
      options.databaseName ?? NATIVE_INTAKE_BROWSER_JOURNAL_DATABASE
    );
    try {
      return await new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = database.transaction(STORE, "readwrite", { durability: "strict" });
        } catch {
          reject(new NativeIntakeBrowserJournalError("durability"));
          return;
        }
        let result: T;
        let ready = false;
        let failure: Error | undefined;
        const fail = (error: unknown) => {
          failure =
            error instanceof Error ? error : new NativeIntakeBrowserJournalError("durability");
          try {
            tx.abort();
          } catch {
            reject(failure);
          }
        };
        tx.onabort = () => {
          reject(failure ?? new NativeIntakeBrowserJournalError("durability"));
        };
        tx.onerror = () => {
          failure ??= new NativeIntakeBrowserJournalError("durability");
        };
        tx.oncomplete = () => {
          if (failure || !ready)
            reject(failure ?? new NativeIntakeBrowserJournalError("durability"));
          else resolve(result);
        };
        if (tx.durability !== "strict") {
          fail(new NativeIntakeBrowserJournalError("durability"));
          return;
        }
        try {
          const store = tx.objectStore(STORE);
          const requestIndex = store.index("request");
          if (
            JSON.stringify(store.keyPath) !== JSON.stringify(KEY_PATH) ||
            JSON.stringify(requestIndex.keyPath) !== JSON.stringify(REQUEST_KEY_PATH) ||
            !requestIndex.unique
          ) {
            fail(new NativeIntakeBrowserJournalError("corrupt"));
            return;
          }
          const read: IDBRequest<unknown[]> = store.getAll();
          read.onsuccess = () => {
            try {
              const { records, unreadable } = readRecords(read.result);
              result = operate(records, store, unreadable);
              ready = true;
            } catch (error) {
              fail(error);
            }
          };
        } catch (error) {
          fail(error);
        }
      });
    } finally {
      database.close();
    }
  }

  return {
    async list(binding) {
      const snapshot = bindingSnapshot(binding);
      return transaction((records) =>
        records
          .filter((record) => sameBinding(record.binding, snapshot))
          .sort(
            (left, right) =>
              left.createdAt - right.createdAt ||
              left.command.inputId.localeCompare(right.command.inputId)
          )
      );
    },
    async save(record) {
      // Snapshot synchronously, before opening IndexedDB or yielding to caller mutation.
      const snapshot = recordSnapshot(record);
      await transaction((records, store) => {
        const existing = records.find(
          (item) =>
            sameBinding(item.binding, snapshot.binding) &&
            (item.command.inputId === snapshot.command.inputId ||
              item.command.requestId === snapshot.command.requestId)
        );
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(snapshot))
            throw new NativeIntakeBrowserJournalError("conflict");
          return;
        }
        const bytes = records.reduce(
          (total, item) => total + encodedBytes(item),
          encodedBytes(snapshot)
        );
        if (
          records.length >= NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS ||
          bytes > NATIVE_INTAKE_BROWSER_JOURNAL_MAX_BYTES
        ) {
          throw new NativeIntakeBrowserJournalError("capacity");
        }
        // add (never put) also enforces immutable input identity at the database boundary.
        store.add(snapshot);
      });
    },
    async unreadable() {
      return transaction((_records, _store, unreadable) => unreadable);
    },
    async countOthers(binding) {
      const snapshot = bindingSnapshot(binding);
      return transaction((records) =>
        records.filter(
          (record) =>
            record.binding.endpoint === snapshot.endpoint &&
            record.binding.projectId === snapshot.projectId &&
            record.binding.principalId !== snapshot.principalId
        ).length
      );
    },
    async discardUnreadable() {
      return transaction((_records, store, unreadable) => {
        if (unreadable === 0) return 0;
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return;
          try {
            recordSnapshot(at.value);
          } catch {
            at.delete();
          }
          at.continue();
        };
        return unreadable;
      });
    },
    async remove(record) {
      const snapshot = recordSnapshot(record);
      await transaction((records, store) => {
        const existing = records.find(
          (item) =>
            sameBinding(item.binding, snapshot.binding) &&
            item.command.inputId === snapshot.command.inputId
        );
        if (!existing) throw new NativeIntakeBrowserJournalError("missing");
        // Only the exact original that was shown may be retired.
        if (JSON.stringify(existing) !== JSON.stringify(snapshot))
          throw new NativeIntakeBrowserJournalError("conflict");
        // The stored key carries the transport the record was saved under.
        store.delete([
          ...BINDING_KEYS.map((key) => existing.binding[key as keyof NativeIntakeBrowserBinding]),
          existing.command.inputId,
        ]);
      });
    },
    async confirm(record) {
      const snapshot = recordSnapshot(record);
      await transaction((records) => {
        const existing = records.find(
          (item) =>
            sameBinding(item.binding, snapshot.binding) &&
            item.command.inputId === snapshot.command.inputId
        );
        if (!existing) throw new NativeIntakeBrowserJournalError("missing");
        if (JSON.stringify(existing) !== JSON.stringify(snapshot))
          throw new NativeIntakeBrowserJournalError("conflict");
      });
    },
  };
}

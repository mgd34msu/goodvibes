import { describe, expect, test } from "bun:test";
import {
  createNativeExecutionBrowserJournal,
  NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_RECORDS,
  type NativeExecutionBrowserRecord,
} from "./native-execution-journal";
import {
  createNativeIntakeBrowserJournal,
  NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS,
  type NativeIntakeBrowserBinding,
  type NativeIntakeBrowserRecord,
} from "./native-intake-journal";

const binding: NativeIntakeBrowserBinding = {
  endpoint: "https://daemon.example/project",
  projectId: "project-1",
  principalId: "principal-1",
  transport: "direct",
};
const bindingPaths = ["endpoint", "projectId", "principalId", "transport"].map((key) => `binding.${key}`);

function intake(id: string): NativeIntakeBrowserRecord {
  return {
    binding: { ...binding },
    command: { requestId: `request-${id}`, inputId: `input-${id}`, text: `task ${id}`, unsupportedSources: [] },
    createdAt: 1,
  };
}
function execution(id: string): NativeExecutionBrowserRecord {
  return {
    binding: { ...binding },
    inputId: `input-${id}`,
    requestId: `request-${id}`,
    target: { workId: `work-${id}`, attemptId: `attempt-${id}`, expectedRevision: { work: 3, criteria: 2, attempt: 1 } },
  };
}

function read(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], value);
}

/** An in-memory object store behind the IndexedDB surface the journals use: one transaction per call, applied on completion. */
function fakeIndexedDb(inputPath: string, requestPath: string) {
  const values: unknown[] = [];
  const keyPath = [...bindingPaths, inputPath];
  const requestKeyPath = [...bindingPaths, requestPath];
  const database = {
    onversionchange: null as (() => void) | null,
    close() {},
    createObjectStore: () => ({ createIndex() {} }),
    transaction() {
      let aborted = false;
      const added: unknown[] = [];
      const deleted: unknown[][] = [];
      let readRequest: { result: unknown[]; onsuccess: (() => void) | null } | undefined;
      const tx = {
        durability: "strict",
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        onerror: null as (() => void) | null,
        abort() {
          aborted = true;
        },
        objectStore: () => ({
          keyPath,
          index: () => ({ keyPath: requestKeyPath, unique: true }),
          getAll() {
            readRequest = { result: structuredClone(values), onsuccess: null };
            return readRequest;
          },
          add(value: unknown) {
            added.push(structuredClone(value));
          },
          delete(key: unknown[]) {
            deleted.push(key);
          },
        }),
      };
      queueMicrotask(() => {
        readRequest?.onsuccess?.();
        if (aborted) {
          tx.onabort?.();
          return;
        }
        for (const key of deleted) {
          const index = values.findIndex((value) => keyPath.every((path, at) => read(value, path) === key[at]));
          if (index >= 0) values.splice(index, 1);
        }
        values.push(...added);
        tx.oncomplete?.();
      });
      return tx;
    },
  };
  const factory = {
    open() {
      const request = {
        result: database,
        transaction: { abort() {} },
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
  return { values, factory };
}

describe("native intake journal retirement", () => {
  test("a full journal accepts a new request once a settled one is removed, and names that way out", async () => {
    const db = fakeIndexedDb("command.inputId", "command.requestId");
    const journal = createNativeIntakeBrowserJournal({ indexedDB: db.factory });
    const originals = Array.from({ length: NATIVE_INTAKE_BROWSER_JOURNAL_MAX_RECORDS }, (_, index) => intake(String(index)));
    db.values.push(...originals);

    const full = await journal.save(intake("new")).catch((error: unknown) => error);
    expect(full).toMatchObject({ code: "capacity" });
    expect((full as Error).message).toContain("Release");

    await journal.remove(originals[3]!);
    await journal.save(intake("new"));
    expect((await journal.list(binding)).map((item) => item.command.inputId)).toContain("input-new");
    expect((await journal.list(binding)).map((item) => item.command.inputId)).not.toContain("input-3");
  });

  test("remove refuses a record that differs from the stored original and one that is not stored", async () => {
    const db = fakeIndexedDb("command.inputId", "command.requestId");
    const journal = createNativeIntakeBrowserJournal({ indexedDB: db.factory });
    await journal.save(intake("1"));
    const altered = intake("1");
    altered.command.text = "different text";
    await expect(journal.remove(altered)).rejects.toMatchObject({ code: "conflict" });
    await expect(journal.remove(intake("2"))).rejects.toMatchObject({ code: "missing" });
    expect(db.values).toHaveLength(1);
  });

  test("a record that fails the current shape is skipped and counted, not a failure of the whole journal", async () => {
    const db = fakeIndexedDb("command.inputId", "command.requestId");
    const journal = createNativeIntakeBrowserJournal({ indexedDB: db.factory });
    const good = intake("good");
    const written = { ...intake("future"), fieldFromANewerBuild: true };
    db.values.push(written, good);

    expect(await journal.list(binding)).toEqual([good]);
    expect(await journal.unreadable()).toBe(1);
    await journal.save(intake("new"));
    await journal.confirm(good);
    expect(db.values).toContainEqual(written);
  });
});

describe("native execution journal retirement", () => {
  test("a full journal accepts a new target once a settled one is removed", async () => {
    const db = fakeIndexedDb("inputId", "requestId");
    const journal = createNativeExecutionBrowserJournal({ indexedDB: db.factory });
    const originals = Array.from({ length: NATIVE_EXECUTION_BROWSER_JOURNAL_MAX_RECORDS }, (_, index) => execution(String(index)));
    db.values.push(...originals);

    const full = await journal.save(execution("new")).catch((error: unknown) => error);
    expect(full).toMatchObject({ code: "capacity" });
    expect((full as Error).message).toContain("Release");

    await journal.remove(originals[0]!);
    await journal.save(execution("new"));
    expect(await journal.get(binding, "input-new")).toEqual(execution("new"));
    expect(await journal.get(binding, "input-0")).toBeNull();
  });

  test("a damaged target is skipped instead of hiding every other target", async () => {
    const db = fakeIndexedDb("inputId", "requestId");
    const journal = createNativeExecutionBrowserJournal({ indexedDB: db.factory });
    db.values.push({ ...execution("bad"), extra: 1 }, execution("good"));
    expect(await journal.get(binding, "input-good")).toEqual(execution("good"));
    expect(await journal.get(binding, "input-bad")).toBeNull();
    await journal.save(execution("new"));
  });
});

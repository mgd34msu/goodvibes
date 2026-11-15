import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getClientLifetime, tokenStore } from "./client-lifetime";
import { openNativeIntake, type NativeIntakeJournal, type NativeIntakeScope } from "./native-intake";
import type { NativeExecutionBrowserJournal } from "./native-execution-journal";
import type { NativeIntakeBrowserRecord } from "./native-intake-journal";

const originalFetch = globalThis.fetch;
const cleanups: (() => void)[] = [];
beforeEach(async () => {
  await tokenStore.setToken("synthetic-native-owner");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  globalThis.fetch = originalFetch;
  await tokenStore.clearToken();
});

type Admitted = "refused" | "turn";

/** A daemon that admits every request as `admitted`, and reports its turn as `turnState` once routed. */
function harness(admitted: Admitted, turnState: "running" | "completed") {
  const rows: NativeIntakeBrowserRecord[] = [];
  let command: { requestId: string; inputId: string; text: string } | undefined;
  let state: Record<string, unknown> | undefined;
  const journal: NativeIntakeJournal = {
    async list() {
      return structuredClone(rows);
    },
    async save(record) {
      rows.push(structuredClone(record));
    },
    async confirm(record) {
      if (!rows.some((row) => JSON.stringify(row) === JSON.stringify(record))) throw new Error("mismatch");
    },
    async remove(record) {
      const index = rows.findIndex((row) => JSON.stringify(row) === JSON.stringify(record));
      if (index < 0) throw new Error("mismatch");
      rows.splice(index, 1);
    },
    async unreadable() {
      return 0;
    },
  };
  const executionJournal: NativeExecutionBrowserJournal = {
    async get() {
      return null;
    },
    async save() {},
    async confirm() {},
    async remove() {},
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (path === "/api/control-plane/auth")
      return Response.json({
        authenticated: true,
        admin: true,
        principalKind: "token",
        principalId: "paired-owner",
        scopes: ["read:work-ledger", "write:work-ledger", "write:sessions"],
        roles: [],
        authMode: "shared-token",
        tokenPresent: true,
        authorizationHeaderPresent: true,
        sessionCookiePresent: false,
      });
    if (path === "/api/work-ledger/project") return Response.json({ projectId: "native-project" });
    if (path === "/api/work-ledger/intake/capture") {
      command = body as typeof command;
      state = {
        kind: "captured",
        projectId: "native-project",
        requestId: command!.requestId,
        sourceRef: { version: 1, inputId: command!.inputId, sourceId: "host-source", sourceRevision: "host-revision", sessionId: "host-session" },
      };
    } else if (path === "/api/work-ledger/intake/admit") {
      state = admitted === "refused"
        ? { ...state, kind: "refused", reason: "semantic" }
        : { ...state, kind: "turn", route: "answer", text: command!.text };
    } else if (path === "/api/work-ledger/turn/status") {
      return Response.json({
        projectId: "native-project",
        requestId: command!.requestId,
        inputId: command!.inputId,
        sourceRevision: "host-revision",
        state: turnState,
        sessionId: "hosted-session",
        brokerInputId: "broker-input",
        correlationId: "native-correlation",
      });
    } else if (path !== "/api/work-ledger/intake/get") throw new Error(`Unexpected route ${path}`);
    return Response.json(state ?? { kind: "not-found" });
  }) as typeof fetch;
  let counter = 0;
  async function open(scope: NativeIntakeScope = {}) {
    const session = await openNativeIntake(
      getClientLifetime(),
      new AbortController().signal,
      journal,
      () => `logical-${++counter}`,
      executionJournal,
      scope
    );
    cleanups.push(() => session.dispose());
    return session;
  }
  return { rows, open };
}

describe("releasing a saved native request", () => {
  test("a request the daemon refused is removed, freeing its place in the journal", async () => {
    const h = harness("refused", "running");
    const session = await h.open();
    await session.submit({ text: "do the thing", unsupportedSources: [] }, () => {});
    expect(h.rows).toHaveLength(1);

    const outcome = await session.release(h.rows[0]!);

    expect(outcome.released).toBe(true);
    expect(h.rows).toHaveLength(0);
  });

  test("a conversation turn that finished is removed", async () => {
    const h = harness("turn", "completed");
    const session = await h.open();
    await session.submit({ text: "do the thing", unsupportedSources: [] }, () => {});

    expect((await session.release(h.rows[0]!)).released).toBe(true);
    expect(h.rows).toHaveLength(0);
  });

  test("an original saved under another session is listed and released from a form with no scope of its own", async () => {
    const h = harness("refused", "running");
    const other = await h.open();
    await other.submit({ text: "from elsewhere", unsupportedSources: [] }, () => {});
    // A form scoped to a session sees none of it in its own list, yet it counts toward capacity.
    const session = await h.open({ continuationSessionId: "other-session" });
    expect(await session.list()).toHaveLength(0);
    const others = await session.listOtherScopes();
    expect(others).toHaveLength(1);

    const outcome = await session.release(others[0]!);

    expect(outcome.released).toBe(true);
    expect(h.rows).toHaveLength(0);
  });

  test("a conversation turn still running keeps its original and reports why", async () => {
    const h = harness("turn", "running");
    const session = await h.open();
    await session.submit({ text: "do the thing", unsupportedSources: [] }, () => {});

    const outcome = await session.release(h.rows[0]!);

    expect(outcome.released).toBe(false);
    expect(outcome.result.kind).toBe("turn");
    expect(h.rows).toHaveLength(1);
  });
});

import { describe, expect, test } from "bun:test";
import { createNativeIntakeExecution } from "./native-execution";
import { createNativeIntakeTurn } from "./native-turn";
import type { NativeExecutionBrowserRecord } from "./native-execution-journal";
import type { NativeIntakeBrowserBinding, NativeIntakeBrowserRecord } from "./native-intake-journal";

const binding: NativeIntakeBrowserBinding = {
  endpoint: "https://daemon.example/project",
  projectId: "project-1",
  principalId: "principal-1",
  transport: "direct",
};
const original: NativeIntakeBrowserRecord = {
  binding,
  command: { requestId: "request-1", inputId: "input-1", text: "task", unsupportedSources: [] },
  createdAt: 1,
};
const tick = () => Promise.resolve();

describe("two overlapping requests for the same original", () => {
  test("native execution is started once", async () => {
    let started = 0;
    const saved: NativeExecutionBrowserRecord[] = [];
    const execution = createNativeIntakeExecution({
      binding,
      client: {
        async status() {
          await tick();
          if (started === 0) throw Object.assign(new Error("none"), { code: "NATIVE_EXECUTION_NOT_FOUND" });
          return { kind: "execution", state: "launch-claimed" };
        },
        async start() {
          await tick();
          started += 1;
          return { kind: "execution", state: "launch-claimed" };
        },
      } as never,
      journal: {
        async get() {
          return saved[0] ?? null;
        },
        async save(record: NativeExecutionBrowserRecord) {
          saved[0] = record;
        },
        async confirm() {},
        async remove() {},
      },
      async confirm() {},
      async inspect() {
        return {
          kind: "work",
          receipt: { workId: "work-1", attemptId: "attempt-1", expectedRevision: { work: 1, criteria: 1, attempt: 1 } },
        } as never;
      },
      active() {},
    });

    await Promise.all([execution.request(original), execution.request(original)]);

    expect(started).toBe(1);
  });

  test("a hosted conversation turn is started once", async () => {
    let started = 0;
    const turn = createNativeIntakeTurn({
      binding,
      async invoke(method) {
        await tick();
        if (method === "workLedger.turn.start") started += 1;
        if (started === 0) return { kind: "not-found" };
        return {
          projectId: "project-1",
          requestId: "request-1",
          inputId: "input-1",
          sourceRevision: "revision-1",
          state: "running",
          sessionId: "session-1",
          brokerInputId: "broker-1",
          correlationId: "correlation-1",
        };
      },
      async confirm() {},
      async inspect() {
        return {
          kind: "turn",
          projectId: "project-1",
          requestId: "request-1",
          sourceRef: { version: 1, inputId: "input-1", sourceId: "source-1", sourceRevision: "revision-1", sessionId: "session-1" },
          text: "task",
          route: "answer",
        } as never;
      },
      active() {},
    });

    await Promise.all([turn.request(original), turn.request(original)]);

    expect(started).toBe(1);
  });
});

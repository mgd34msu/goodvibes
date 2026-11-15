import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
  NativeIntakeResult,
  NativeIntakeSession,
  NativeIntakeSource,
} from "../../lib/native-intake";
import {
  NativeIntakeBrowserJournalError,
  type NativeIntakeBrowserRecord,
} from "../../lib/native-intake-journal";
import type { NativeExecutionObservation } from "../../lib/native-execution";
import type { NativeTurnObservation } from "../../lib/native-turn";
import { getClientLifetime, invalidateClientLifetime } from "../../lib/client-lifetime";

const original = "  Keep every word.\nRepeat. Repeat.  ";
const record: NativeIntakeBrowserRecord = {
  binding: {
    endpoint: "http://localhost:3000",
    projectId: "project",
    principalId: "owner",
    transport: "direct",
  },
  command: {
    inputId: "input-original",
    requestId: "request-original",
    text: original,
    unsupportedSources: [],
  },
  createdAt: 1,
};
const common = {
  projectId: "project",
  requestId: record.command.requestId,
  sourceRef: {
    version: 1 as const,
    inputId: record.command.inputId,
    sourceId: "source",
    sourceRevision: "source-v1",
    sessionId: "session",
  },
};
const work: Extract<NativeIntakeResult, { kind: "work" }> = {
  kind: "work",
  ...common,
  receipt: {
    projectId: "project",
    requestId: common.requestId,
    inputId: common.sourceRef.inputId,
    ledgerRevision: 1,
    workId: "work-original",
    attemptId: "attempt-original",
    expectedRevision: { work: 1, criteria: 1, attempt: 1 },
    goal: original,
    criteria: ["  Keep every word.", "Repeat.", "Repeat."],
    source: {
      version: 2,
      sourceId: "source",
      sourceRevision: "source-v1",
      sessionId: "session",
      offsetEncoding: "utf16",
      proposalRevision: "proposal-v1",
      spans: [],
      admissionDecisionId: "admission-real",
      judgmentDecisionIds: ["judgment-real"],
    },
  },
};
const turn: Extract<NativeIntakeResult, { kind: "turn" }> = {
  kind: "turn",
  ...common,
  route: "answer",
  text: original,
};
const turnTarget = {
  projectId: common.projectId,
  inputId: common.sourceRef.inputId,
  sourceRevision: common.sourceRef.sourceRevision,
};
const turnRunning: NativeTurnObservation = {
  kind: "recorded",
  target: turnTarget,
  snapshot: {
    ...turnTarget,
    requestId: common.requestId,
    state: "running",
    sessionId: "hosted-session-real",
    brokerInputId: "broker-input-real",
    correlationId: "correlation-real",
  },
};
const turnCancelled: NativeTurnObservation = {
  ...turnRunning,
  snapshot: { ...turnRunning.snapshot, state: "cancelled" },
};
const target = {
  workId: work.receipt.workId,
  attemptId: work.receipt.attemptId,
  expectedRevision: work.receipt.expectedRevision,
};
const running: NativeExecutionObservation = {
  kind: "recorded",
  target,
  snapshot: {
    ...target,
    projectId: "project",
    currentRevision: target.expectedRevision,
    currentAttempt: true,
    stale: false,
    kind: "execution",
    state: "launch-claimed",
    recovery: "available",
    receipt: { contractId: "contract-real", ownerAgentId: "owner-real" },
    progress: null,
  },
};
const prevented: NativeExecutionObservation = {
  kind: "recorded",
  target,
  snapshot: {
    ...target,
    projectId: "project",
    currentRevision: target.expectedRevision,
    currentAttempt: true,
    stale: false,
    kind: "prevented-before-admission",
    state: "cancelled",
    recovery: "cancelled",
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let session: NativeIntakeSession;
const open = mock(async () => session);
mock.module("../../lib/native-intake", () => ({
  openNativeIntake: open,
}));
const { NativeIntakeForm } = await import("./NativeIntakeForm");
const cleanups: (() => void)[] = [];
function fixture() {
  return {
    binding: record.binding,
    list: mock(async (): Promise<NativeIntakeBrowserRecord[]> => []),
    listOtherScopes: mock(async (): Promise<NativeIntakeBrowserRecord[]> => []),
    submit: mock(
      async (
        _source: NativeIntakeSource,
        saved: (original: NativeIntakeBrowserRecord) => void,
        _signal?: AbortSignal
      ): Promise<NativeIntakeResult> => {
        saved(record);
        return work;
      }
    ),
    inspect: mock(
      async (
        _record: NativeIntakeBrowserRecord,
        _signal?: AbortSignal
      ): Promise<NativeIntakeResult> => work
    ),
    retry: mock(
      async (
        _record: NativeIntakeBrowserRecord,
        _signal?: AbortSignal
      ): Promise<NativeIntakeResult> => work
    ),
    resume: mock(
      async (
        _record: NativeIntakeBrowserRecord,
        _signal?: AbortSignal
      ): Promise<NativeIntakeResult> => work
    ),
    cancel: mock(
      async (
        _record: NativeIntakeBrowserRecord,
        _signal?: AbortSignal
      ): Promise<NativeIntakeResult> => ({ kind: "cancelled", ...common })
    ),
    release: mock(
      async (
        _record: NativeIntakeBrowserRecord,
        _signal?: AbortSignal
      ): Promise<{ released: boolean; result: NativeIntakeResult }> => ({ released: false, result: work })
    ),
    execution: {
      inspect: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeExecutionObservation> => ({ kind: "not-found", target })
      ),
      request: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeExecutionObservation> => running
      ),
      resume: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeExecutionObservation> => running
      ),
      cancel: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeExecutionObservation> => prevented
      ),
    },
    turn: {
      inspect: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeTurnObservation> => ({ kind: "not-requested" })
      ),
      request: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeTurnObservation> => turnRunning
      ),
      cancel: mock(
        async (
          _record: NativeIntakeBrowserRecord,
          _signal?: AbortSignal
        ): Promise<NativeTurnObservation> => turnCancelled
      ),
    },
    dispose: mock(() => {}),
  };
}
let connected: ReturnType<typeof fixture>;
beforeEach(() => {
  connected = fixture();
  session = connected;
  open.mockClear();
});
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
/** Let every already-resolved promise chain run; no wall-clock wait. */
async function drain() {
  for (let turn = 0; turn < 10; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  flushSync(() => {});
}
async function settle(check: () => boolean) {
  for (let tries = 0; tries < 100; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    flushSync(() => {});
    if (check()) return;
  }
  expect(check()).toBe(true);
}
async function render(
  onOpenSession?: (sessionId: string) => void,
  initial: Pick<Parameters<typeof NativeIntakeForm>[0], "continuationSessionId" | "projectId" | "closed" | "selectedDiff"> = {}
) {
  let scope = initial;
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  flushSync(() =>
    root.render(
      <NativeIntakeForm lifetime={getClientLifetime()} onOpenSession={onOpenSession} {...scope} />
    )
  );
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    flushSync(() => root.unmount());
    el.remove();
  };
  const rerender = (next: typeof scope = scope) => {
    scope = next;
    flushSync(() =>
      root.render(
        <NativeIntakeForm lifetime={getClientLifetime()} onOpenSession={onOpenSession} {...scope} />
      )
    );
  };
  cleanups.push(unmount);
  const button = (label: string) =>
    [...el.querySelectorAll("button")].find((item) => item.textContent === label);
  const click = (label: string) => {
    const item = button(label);
    expect(item).toBeDefined();
    flushSync(() => item!.click());
  };
  await settle(() =>
    Boolean(button("Send") || el.textContent?.includes("This session is closed"))
  );
  return { el, button, click, unmount, rerender };
}
function submit(el: HTMLElement) {
  const field = el.querySelector("textarea");
  expect(field).not.toBeNull();
  flushSync(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(
      field,
      original
    );
    field!.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  flushSync(() =>
    el
      .querySelector("form")!
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }))
  );
}

const textareaValue = (el: HTMLElement) => el.querySelector("textarea")?.value;
const rows = (el: HTMLElement) => el.querySelectorAll(".native-intake__saved li").length;

describe("A message that becomes work", () => {
  test("one Send keeps the exact text, starts the work once and keeps the box ready", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.execution.request.mockImplementation(() => pending.promise);
    const { el, button } = await render();
    submit(el);
    await settle(() => connected.execution.request.mock.calls.length === 1 && button("Cancel")?.disabled === false);
    expect(connected.submit.mock.calls[0]?.[0]).toEqual({ text: original, unsupportedSources: [] });
    expect(connected.execution.request.mock.calls[0]?.[0]).toBe(record);
    expect(el.querySelector("pre")?.textContent).toBe(original);
    expect(textareaValue(el)).toBe("");
    expect(el.textContent).toContain("admission-real");
    pending.resolve(running);
    await settle(() => el.textContent?.includes("contract-real") === true);
    expect(connected.execution.request).toHaveBeenCalledTimes(1);
    expect(connected.execution.resume).not.toHaveBeenCalled();
    expect(connected.turn.request).not.toHaveBeenCalled();
  });

  test("a start that fails is offered once as Try again and is never repeated by itself", async () => {
    connected.execution.request.mockRejectedValue(new Error("Native execution requires write:fleet."));
    const { el, button, click } = await render();
    submit(el);
    await settle(() => el.textContent?.includes("requires write:fleet") === true && Boolean(button("Try again")));
    expect(el.textContent).toContain("Needs you");
    expect(el.querySelector("pre")?.textContent).toBe(original);
    await drain();
    expect(connected.execution.request).toHaveBeenCalledTimes(1);
    connected.execution.request.mockResolvedValue(running);
    click("Try again");
    await settle(() => el.textContent?.includes("contract-real") === true);
    expect(connected.execution.request).toHaveBeenCalledTimes(2);
  });

  test("reopening carries admitted work on: one start, only on the host's exact absence", async () => {
    connected.list.mockResolvedValue([record]);
    const { el } = await render();
    await settle(() => connected.execution.request.mock.calls.length === 1 && el.textContent?.includes("contract-real") === true);
    await drain();
    expect(connected.execution.request).toHaveBeenCalledTimes(1);
    expect(connected.submit).not.toHaveBeenCalled();
    expect(connected.retry).not.toHaveBeenCalled();
    expect(connected.execution.resume).not.toHaveBeenCalled();
  });

  test("reopening work that is already running only reads it", async () => {
    connected.list.mockResolvedValue([record]);
    connected.execution.inspect.mockResolvedValue(running);
    const { el } = await render();
    await settle(() => el.textContent?.includes("contract-real") === true);
    await drain();
    expect(connected.execution.request).not.toHaveBeenCalled();
    expect(connected.execution.resume).not.toHaveBeenCalled();
    expect(connected.submit).not.toHaveBeenCalled();
  });

  test("a captured message is carried through by itself; an interrupted one waits for Continue", async () => {
    for (const kind of ["captured", "processing"] as const) {
      connected = fixture();
      session = connected;
      connected.list.mockResolvedValue([record]);
      connected.inspect.mockResolvedValue(
        kind === "captured" ? { kind, ...common } : { kind, ...common, recovery: "required", stage: "waiting" }
      );
      connected.execution.inspect.mockResolvedValue({ kind: "not-requested" });
      const { el, button, click, unmount } = await render();
      if (kind === "processing") {
        await settle(() => button("Continue")?.disabled === false);
        expect(connected.resume).not.toHaveBeenCalled();
        click("Continue");
      }
      await settle(() => el.textContent?.includes("contract-real") === true);
      expect(kind === "captured" ? connected.retry : connected.resume).toHaveBeenCalledTimes(1);
      expect(connected.execution.request).toHaveBeenCalledTimes(1);
      expect(connected.execution.resume).not.toHaveBeenCalled();
      unmount();
    }
  });

  test("a message that becomes a reply never starts work", async () => {
    connected.submit.mockImplementation(async (_source, saved) => {
      saved(record);
      return turn;
    });
    const { el } = await render();
    submit(el);
    await settle(() => connected.turn.request.mock.calls.length === 1);
    expect(connected.execution.request).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain("contract-real");
  });

  test("blocked and refused messages start nothing and offer nothing to press", async () => {
    for (const found of [
      { kind: "blocked", ...common, reason: "missing-context", recovery: "required" },
      { kind: "refused", ...common, reason: "semantic" },
    ] as const) {
      connected = fixture();
      session = connected;
      connected.submit.mockImplementation(async (_source, saved) => {
        saved(record);
        return found;
      });
      const { el, button, unmount } = await render();
      submit(el);
      await settle(() => el.textContent?.includes("Not started") === true);
      expect(connected.turn.request).not.toHaveBeenCalled();
      expect(connected.execution.request).not.toHaveBeenCalled();
      expect(button("Cancel")).toBeUndefined();
      expect(el.textContent).not.toContain("Needs you");
      unmount();
    }
  });

  test("Cancel interrupts a pending start and a late answer cannot overwrite it", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.execution.request.mockImplementation(() => pending.promise);
    const { el, click, button } = await render();
    submit(el);
    await settle(() => button("Cancel")?.disabled === false && connected.execution.request.mock.calls.length === 1);
    const oldSignal = connected.execution.request.mock.calls[0]?.[1];
    click("Cancel");
    await settle(() => el.textContent?.includes("Cancelled before the work started") === true);
    expect(oldSignal?.aborted).toBe(true);
    expect(connected.execution.cancel).toHaveBeenCalledTimes(1);
    pending.resolve(running);
    await drain();
    expect(el.textContent).toContain("Cancelled before the work started");
    expect(el.textContent).not.toContain("contract-real");
  });

  test("Cancel interrupts the reopening status read", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.list.mockResolvedValue([record]);
    connected.execution.inspect.mockImplementation(() => pending.promise);
    const { el, button, click } = await render();
    await settle(() => button("Cancel")?.disabled === false);
    const oldSignal = connected.execution.inspect.mock.calls[0]?.[1];
    click("Cancel");
    await settle(() => el.textContent?.includes("Cancelled before the work started") === true);
    expect(oldSignal?.aborted).toBe(true);
    pending.resolve(running);
    await drain();
    expect(el.textContent).not.toContain("contract-real");
    expect(connected.execution.request).not.toHaveBeenCalled();
  });

  test("sending another message detaches the pending start without cancelling it", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.execution.request.mockImplementation(() => pending.promise);
    const { el } = await render();
    submit(el);
    await settle(() => connected.execution.request.mock.calls.length === 1);
    const oldSignal = connected.execution.request.mock.calls[0]?.[1];
    const next: NativeIntakeBrowserRecord = {
      ...record,
      command: { ...record.command, inputId: "next-input", requestId: "next-request" },
      createdAt: 2,
    };
    connected.submit.mockImplementation(async (_source, saved) => {
      saved(next);
      return { kind: "processing", ...common, requestId: "next-request", sourceRef: { ...common.sourceRef, inputId: "next-input" }, recovery: "pending", stage: "waiting" } as NativeIntakeResult;
    });
    submit(el);
    await settle(() => connected.submit.mock.calls.length === 2 && rows(el) === 2);
    expect(oldSignal?.aborted).toBe(true);
    pending.resolve(running);
    await drain();
    expect(el.textContent).not.toContain("contract-real");
    expect(connected.cancel).not.toHaveBeenCalled();
    expect(connected.execution.cancel).not.toHaveBeenCalled();
    expect(el.querySelector("textarea")).not.toBeNull();
  });

  test("closing detaches and disposes without cancelling anything on the host", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.execution.request.mockImplementation(() => pending.promise);
    const { el, unmount } = await render();
    submit(el);
    await settle(() => connected.execution.request.mock.calls.length === 1);
    const oldSignal = connected.execution.request.mock.calls[0]?.[1];
    unmount();
    expect(oldSignal?.aborted).toBe(true);
    expect(connected.dispose).toHaveBeenCalledTimes(1);
    expect(connected.cancel).not.toHaveBeenCalled();
    expect(connected.execution.cancel).not.toHaveBeenCalled();
    pending.resolve(running);
    await drain();
  });

  test("a connection change clears the previous message and fences its late answer", async () => {
    const pending = deferred<NativeExecutionObservation>();
    connected.execution.request.mockImplementation(() => pending.promise);
    const old = connected;
    const { el, button, rerender } = await render();
    submit(el);
    await settle(() => old.execution.request.mock.calls.length === 1);
    connected = fixture();
    session = connected;
    invalidateClientLifetime();
    rerender();
    await settle(() => button("Send")?.disabled === true);
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(old.execution.request.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(el.textContent).not.toContain("admission-real");
    expect(rows(el)).toBe(0);
    pending.resolve(running);
    await drain();
    expect(el.textContent).not.toContain("contract-real");
    expect(connected.execution.request).not.toHaveBeenCalled();
  });
});

describe("A message that becomes a reply", () => {
  beforeEach(() => {
    connected.submit.mockImplementation(async (_source, saved) => {
      saved(record);
      return turn;
    });
  });

  test("one Send starts the reply once and Cancel is offered before it is acknowledged", async () => {
    const pending = deferred<NativeTurnObservation>();
    connected.turn.request.mockImplementation(() => pending.promise);
    const { el, button } = await render();
    submit(el);
    await settle(() => connected.turn.request.mock.calls.length === 1 && button("Cancel")?.disabled === false);
    expect(connected.turn.request.mock.calls[0]?.[0]).toBe(record);
    expect(el.querySelector("pre")?.textContent).toBe(original);
    pending.resolve(turnRunning);
    await settle(() => el.textContent?.includes("Replying.") === true);
    expect(el.textContent).toContain("hosted-session-real");
    await drain();
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
    expect(connected.execution.request).not.toHaveBeenCalled();
    expect(button("Send again")).toBeUndefined();
  });

  test("a reply whose start was not confirmed is offered once as Try again", async () => {
    connected.turn.request.mockRejectedValue(new Error("Hosted conversation acknowledgement was lost."));
    const { el, button, click } = await render();
    submit(el);
    await settle(() => el.textContent?.includes("acknowledgement was lost") === true && Boolean(button("Try again")));
    await drain();
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
    connected.turn.request.mockResolvedValue(turnRunning);
    click("Try again");
    await settle(() => el.textContent?.includes("Replying.") === true);
    expect(connected.turn.request).toHaveBeenCalledTimes(2);
    expect(connected.submit).toHaveBeenCalledTimes(1);
  });

  test("a failed reply that changed nothing is offered as Send again", async () => {
    connected.turn.request.mockResolvedValue({
      ...turnRunning,
      snapshot: { ...turnRunning.snapshot, state: "failed", failure: { summary: "The provider timed out", retryable: true } },
    } as NativeTurnObservation);
    const { el, button, click } = await render();
    submit(el);
    await settle(() => Boolean(button("Send again")));
    expect(el.textContent).toContain("The provider timed out");
    connected.turn.request.mockResolvedValue(turnRunning);
    click("Send again");
    await settle(() => el.textContent?.includes("Replying.") === true);
    expect(connected.turn.request).toHaveBeenCalledTimes(2);
    expect(connected.release).not.toHaveBeenCalled();
  });

  test("Open the session uses the recorded session id without starting another reply", async () => {
    const opened = mock((_sessionId: string) => {});
    const { el, button, click } = await render(opened);
    submit(el);
    await settle(() => button("Open the session")?.disabled === false);
    click("Open the session");
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0]?.[0]).toBe("hosted-session-real");
    expect(connected.turn.request).toHaveBeenCalledTimes(1);
  });

  test("New work opens the recorded hosted item and closes the form without cancelling", async () => {
    const { NewWorkMenu } = await import("./NewWorkMenu");
    const opened = mock((_key: string) => {});
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    flushSync(() => root.render(<NewWorkMenu lifetime={getClientLifetime()} onCreated={opened} />));
    cleanups.push(() => {
      flushSync(() => root.unmount());
      el.remove();
    });
    const menuButton = el.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    expect(menuButton).not.toBeNull();
    flushSync(() => menuButton!.click());
    const nativeItem = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Ask for work to be done"
    );
    expect(nativeItem).toBeDefined();
    flushSync(() => nativeItem!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await settle(() => Boolean(dialog?.querySelector("textarea")));
    submit(dialog!);
    const openButton = () =>
      [...dialog!.querySelectorAll("button")].find((item) => item.textContent === "Open the session");
    await settle(() => openButton()?.disabled === false);
    flushSync(() => openButton()!.click());
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened.mock.calls[0]?.[0]).toBe("hosted:hosted-session-real");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(connected.dispose).toHaveBeenCalledTimes(1);
    expect(connected.turn.cancel).not.toHaveBeenCalled();
    expect(connected.cancel).not.toHaveBeenCalled();
  });
});

describe("Messages kept in this browser", () => {
  beforeEach(() => {
    connected.submit.mockImplementation(async (_source, saved) => {
      saved(record);
      return turn;
    });
  });

  test("a finished message is dropped from the browser store and its row stays on the page", async () => {
    connected.turn.request.mockResolvedValue({ ...turnRunning, snapshot: { ...turnRunning.snapshot, state: "completed" } } as NativeTurnObservation);
    connected.release.mockResolvedValue({ released: true, result: turn });
    const { el } = await render();
    submit(el);
    await settle(() => connected.release.mock.calls.length === 1);
    expect(connected.release.mock.calls[0]?.[0]).toEqual(record);
    expect(el.textContent).toContain("Replied.");
    expect(rows(el)).toBe(1);
    await drain();
    expect(connected.release).toHaveBeenCalledTimes(1);
  });

  test("a message still in progress is never dropped", async () => {
    const { el } = await render();
    submit(el);
    await settle(() => el.textContent?.includes("Replying.") === true);
    await drain();
    expect(connected.release).not.toHaveBeenCalled();
  });

  test("a full store drops finished messages and sends once more", async () => {
    const other = {
      ...record,
      command: { ...record.command, inputId: "other-input", requestId: "other-request", text: "from another session" },
    } as NativeIntakeBrowserRecord;
    connected.listOtherScopes.mockResolvedValue([other]);
    connected.release.mockResolvedValue({ released: true, result: turn });
    connected.submit.mockImplementationOnce(async () => {
      throw new NativeIntakeBrowserJournalError("capacity");
    });
    const { el } = await render();
    submit(el);
    await settle(() => connected.submit.mock.calls.length === 2 && connected.turn.request.mock.calls.length === 1);
    expect(connected.release.mock.calls[0]?.[0]).toEqual(other);
    expect(el.querySelector("pre")?.textContent).toBe(original);
  });

  test("a full store holding only messages in progress says so and keeps the text", async () => {
    const other = {
      ...record,
      command: { ...record.command, inputId: "other-input", requestId: "other-request", text: "still running" },
    } as NativeIntakeBrowserRecord;
    connected.listOtherScopes.mockResolvedValue([other]);
    connected.submit.mockImplementation(async () => {
      throw new NativeIntakeBrowserJournalError("capacity");
    });
    const { el } = await render();
    submit(el);
    await settle(() => el.textContent?.includes("Not sent") === true);
    expect(textareaValue(el)).toBe(original);
    expect(connected.submit).toHaveBeenCalledTimes(1);
    expect(connected.turn.request).not.toHaveBeenCalled();
  });
});

describe("Messages to a session", () => {
  const continuationRecord: NativeIntakeBrowserRecord = {
    ...record,
    command: { ...record.command, continuation: { sessionId: "native-a" } },
  };
  const queued: NativeTurnObservation = {
    ...turnRunning,
    snapshot: { ...turnRunning.snapshot, state: "queued", sessionId: "native-a" },
  };

  test("reopening reads only this session's messages and keeps Cancel reachable when one read fails", async () => {
    const other = {
      ...continuationRecord,
      command: { ...continuationRecord.command, inputId: "other-input", text: "Other session private source", continuation: { sessionId: "native-b" } },
      createdAt: 3,
    };
    connected.list.mockResolvedValue([record, continuationRecord, other]);
    connected.inspect.mockRejectedValue(new Error("Source temporarily unavailable"));
    connected.turn.inspect.mockResolvedValue(queued);
    connected.execution.inspect.mockResolvedValue({ kind: "not-requested" });
    const { el, button, click } = await render(undefined, { continuationSessionId: "native-a", projectId: "project" });
    await settle(() => button("Cancel")?.disabled === false && el.textContent?.includes("Waiting for the reply in progress") === true);
    expect(open).toHaveBeenCalledWith(getClientLifetime(), expect.any(AbortSignal), undefined, undefined, undefined, {
      continuationSessionId: "native-a",
      projectId: "project",
    });
    expect(connected.turn.inspect.mock.calls[0]?.[0]).toBe(continuationRecord);
    expect(el.textContent).toContain("Source temporarily unavailable");
    expect(el.textContent).not.toContain("Other session private source");
    expect(rows(el)).toBe(1);
    expect(connected.turn.request).not.toHaveBeenCalled();
    connected.turn.cancel.mockResolvedValue({ ...queued, snapshot: { ...queued.snapshot, state: "cancelled" } });
    click("Cancel");
    await settle(() => el.textContent?.includes("Cancelled. Anything already done stays done.") === true);
    expect(connected.turn.cancel.mock.calls[0]?.[0]).toBe(continuationRecord);
  });

  test("the Work form never shows a session's messages", async () => {
    connected.list.mockResolvedValue([continuationRecord]);
    const { el, button } = await render();
    expect(button("Send")).toBeDefined();
    expect(rows(el)).toBe(0);
    expect(connected.inspect).not.toHaveBeenCalled();
    expect(connected.turn.inspect).not.toHaveBeenCalled();
  });

  test("a second message goes out while the first is queued, without cancelling it", async () => {
    connected.submit.mockImplementation(async (_source, saved) => {
      saved(continuationRecord);
      return turn;
    });
    connected.turn.request.mockResolvedValue(queued);
    const { el } = await render(undefined, { continuationSessionId: "native-a" });
    submit(el);
    await settle(() => el.textContent?.includes("Waiting for the reply in progress") === true);
    const next = { ...continuationRecord, command: { ...continuationRecord.command, inputId: "next", requestId: "next-request" }, createdAt: 2 };
    connected.submit.mockImplementation(async (_source, saved) => {
      saved(next);
      return turn;
    });
    submit(el);
    await settle(() => connected.turn.request.mock.calls.length === 2);
    expect(connected.turn.request.mock.calls[1]?.[0]).toBe(next);
    expect(rows(el)).toBe(2);
    expect(connected.turn.cancel).not.toHaveBeenCalled();
  });

  test("moving to another session retires the previous one's pending reply", async () => {
    const pending = deferred<NativeTurnObservation>();
    connected.submit.mockImplementation(async (_source, saved) => {
      saved(continuationRecord);
      return turn;
    });
    connected.turn.request.mockImplementation(() => pending.promise);
    const { el, rerender, button } = await render(undefined, { continuationSessionId: "native-a" });
    submit(el);
    await settle(() => connected.turn.request.mock.calls.length === 1);
    const old = connected;
    connected = fixture();
    session = connected;
    rerender({ continuationSessionId: "native-b" });
    await settle(() => Boolean(button("Send")));
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(old.turn.request.mock.calls[0]?.[1]?.aborted).toBe(true);
    pending.resolve(queued);
    await drain();
    expect(el.textContent).not.toContain("Waiting for the reply in progress");
    expect(connected.turn.request).not.toHaveBeenCalled();
  });

  test("a closed session offers no box and keeps Cancel", async () => {
    connected.list.mockResolvedValue([continuationRecord]);
    connected.inspect.mockResolvedValue(turn);
    connected.turn.inspect.mockResolvedValue(queued);
    connected.execution.inspect.mockResolvedValue({ kind: "not-requested" });
    const { el, button } = await render(undefined, { continuationSessionId: "native-a", closed: true });
    await settle(() => button("Cancel")?.disabled === false);
    expect(el.textContent).toContain("This session is closed");
    expect(button("Send")).toBeUndefined();
    expect(el.querySelector("textarea")).toBeNull();
    expect(connected.turn.request).not.toHaveBeenCalled();
  });
});

test("a comment on a change is kept apart from other hunks and retired when the hunk changes", async () => {
  const selectedDiff = { kind: "session" as const, revision: "a".repeat(64), fileIndex: 0, hunkIndex: 0 };
  const source: NativeIntakeBrowserRecord = { ...record, command: { ...record.command, continuation: { sessionId: "native-a", selectedDiff } } };
  const other: NativeIntakeBrowserRecord = { ...source, command: { ...source.command, inputId: "other-hunk", requestId: "other-hunk-request", text: "Other hunk comment", continuation: { sessionId: "native-a", selectedDiff: { ...selectedDiff, hunkIndex: 1 } } } };
  connected.list.mockResolvedValue([other]);
  connected.submit.mockImplementation(async (_source, saved) => { saved(source); return turn; });
  const pending = deferred<NativeTurnObservation>();
  connected.turn.request.mockImplementation(() => pending.promise);
  const view = await render(undefined, { continuationSessionId: "native-a", selectedDiff });
  expect(view.el.textContent).not.toContain("Other hunk comment");
  submit(view.el);
  await settle(() => connected.turn.request.mock.calls.length === 1);
  expect(connected.submit.mock.calls[0]?.[0]).toEqual({ text: original, unsupportedSources: [] });
  expect(view.el.querySelector("pre.native-intake__source")?.textContent).toBe(original);
  expect(view.el.textContent).toContain("This session's changes");
  const previous = connected;
  connected = fixture(); session = connected;
  view.rerender({ continuationSessionId: "native-a", selectedDiff: { ...selectedDiff, hunkIndex: 1 } });
  await settle(() => Boolean(view.button("Send")));
  expect(previous.dispose).toHaveBeenCalledTimes(1);
  expect(previous.turn.request.mock.calls[0]?.[1]?.aborted).toBe(true);
  pending.resolve(turnRunning);
  await drain();
  expect(view.el.textContent).not.toContain("broker-input-real");
  expect(connected.turn.request).not.toHaveBeenCalled();
});

test("a failed connect offers Retry connection, which reconnects and opens the box", async () => {
  open.mockImplementationOnce(async () => {
    throw new Error("daemon unreachable");
  });
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  cleanups.push(() => {
    flushSync(() => root.unmount());
    el.remove();
  });
  flushSync(() => root.render(<NativeIntakeForm lifetime={getClientLifetime()} />));
  const retry = () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Retry connection");
  await settle(() => Boolean(retry()));
  expect(el.textContent).toContain("daemon unreachable");
  expect(el.querySelector("textarea")).toBeNull();
  flushSync(() => retry()!.click());
  await settle(() => Boolean(el.querySelector("textarea")));
  expect(open).toHaveBeenCalledTimes(2);
  expect(el.textContent).not.toContain("daemon unreachable");
});

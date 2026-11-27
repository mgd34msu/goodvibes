import {
  nativeWorkExecutionIdentitySchema,
  type NativeWorkExecutionIdentity,
  type NativeWorkExecutionSnapshot,
  type OperatorNativeWorkExecutionClient,
} from "@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution-client";
import type { NativeConversationIntakeLookupResult } from "@goodvibes/engine/platform/platform/workflow/work-ledger/native-intake-client";
import type {
  NativeIntakeBrowserBinding,
  NativeIntakeBrowserRecord,
} from "./native-intake-journal";
import type {
  NativeExecutionBrowserJournal,
  NativeExecutionBrowserRecord,
} from "./native-execution-journal";
import { errorCode } from "./errors";

export type NativeExecutionObservation =
  | { kind: "not-requested" }
  | { kind: "not-found"; target: NativeWorkExecutionIdentity }
  | {
      kind: "recorded";
      target: NativeWorkExecutionIdentity;
      snapshot: NativeWorkExecutionSnapshot;
    };

function failure(error: unknown): Error {
  const code = errorCode(error);
  // Said to a person: what happened to the work and what to do, in the Work page's words (work, plan, step, result),
  // never the transport's, the access scopes' or the decision model's own names.
  const messages: Record<string, string> = {
    NATIVE_EXECUTION_UNSUPPORTED_AUTHORITY:
      "The work was not started: this browser's sign-in cannot run work on the daemon. Sign in with your name and password, or pair this browser (Settings, Devices and pairing), then try again.",
    PAIRED_OWNER_REQUIRED:
      "The work was not started: this browser is not signed in as you or paired as your device, so it cannot run work on the daemon. Sign in with your name and password, or pair this browser (Settings, Devices and pairing), then try again.",
    FORBIDDEN:
      "The work was not started: this browser's pairing does not allow running work. Pair it again with full access (Settings, Devices and pairing), then try again.",
    NATIVE_EXECUTION_REFUSED:
      "The decision model refused to start this work, so nothing ran. Nothing was tried again by itself.",
    NATIVE_EXECUTION_DECISION_MODEL_FAILED:
      "Not started: the decision model failed before it decided whether to start this work, so nothing ran. Fix the decision model (its notice says what failed and how), then start the work again.",
    NATIVE_EXECUTION_STALE:
      "The work changed meanwhile, so nothing was done. Look at it again and try once more.",
    NATIVE_EXECUTION_CONFLICT:
      "The work changed meanwhile, so nothing was done. Look at it again and try once more.",
    NATIVE_EXECUTION_RECOVERY_REQUIRED:
      "This work's run cannot be picked up from here, so nothing was run again. Stop it and ask for the work again.",
  };
  return new Error(
    messages[code] ??
      "Whether the work started is not known. Look at it in Work before trying again; nothing was tried again by itself."
  );
}

const sameRevision = (
  left: NativeWorkExecutionIdentity["expectedRevision"],
  right: NativeWorkExecutionIdentity["expectedRevision"]
) => left.work === right.work && left.criteria === right.criteria && left.attempt === right.attempt;

/** Factual protocol states only. A historical receipt never authorizes recovery. */
export function nativeExecutionCanResume(snapshot: NativeWorkExecutionSnapshot): boolean {
  if (snapshot.kind === "prevented-before-admission") return false;
  if (snapshot.kind === "execution") {
    if (snapshot.state === "cancelled") return false;
    if (snapshot.settlement?.state === "published" || snapshot.progress?.status === "passed")
      return true;
    if (snapshot.state === "launch-claimed" || snapshot.recovery === "terminal") return false;
    return (
      snapshot.currentAttempt &&
      !snapshot.stale &&
      (snapshot.recovery === "available" || snapshot.recovery === "required")
    );
  }
  return snapshot.currentAttempt && !snapshot.stale && snapshot.recovery === "required";
}

/**
 * Product dispatch ownership only. The daemon independently validates every
 * identity and owns durable admission, semantic decisions and actual execution.
 * Neither a browser journal nor a serialized admission receipt is authority.
 */
export function createNativeIntakeExecution(options: {
  binding: NativeIntakeBrowserBinding;
  client: OperatorNativeWorkExecutionClient;
  journal: NativeExecutionBrowserJournal;
  /** Confirm the saved original against the journal; called once per action, at its start. */
  confirm(record: NativeIntakeBrowserRecord): Promise<void>;
  /** The daemon's record of the original, already checked against the saved copy. */
  inspect(
    record: NativeIntakeBrowserRecord,
    signal?: AbortSignal
  ): Promise<NativeConversationIntakeLookupResult>;
  active(signal?: AbortSignal): void;
}) {
  const current = (signal?: AbortSignal) => {
    options.active(signal);
    signal?.throwIfAborted();
  };
  async function target(
    original: NativeIntakeBrowserRecord,
    signal?: AbortSignal
  ): Promise<{ saved: NativeExecutionBrowserRecord; stored: boolean } | null> {
    current(signal);
    await options.confirm(original);
    current(signal);
    const saved = await options.journal.get(options.binding, original.command.inputId);
    current(signal);
    if (saved) {
      if (saved.requestId !== original.command.requestId)
        throw new Error("This browser's saved record of the work belongs to another request, so nothing was done. Look at the work in Work.");
      return { saved, stored: true };
    }
    const found = await options.inspect(original, signal);
    current(signal);
    if (found.kind !== "work") return null;
    // Copy only the canonical host identity, never source/proof/actor fields.
    return { stored: false, saved: {
      binding: { ...options.binding },
      inputId: original.command.inputId,
      requestId: original.command.requestId,
      target: nativeWorkExecutionIdentitySchema.parse({
        workId: found.receipt.workId,
        attemptId: found.receipt.attemptId,
        expectedRevision: found.receipt.expectedRevision,
      }),
    } };
  }
  async function status(
    saved: NativeExecutionBrowserRecord,
    signal?: AbortSignal
  ): Promise<NativeExecutionObservation> {
    current(signal);
    try {
      const snapshot = await options.client.status(saved.target, { signal });
      current(signal);
      return { kind: "recorded", target: saved.target, snapshot };
    } catch (error) {
      current(signal);
      if (errorCode(error) === "NATIVE_EXECUTION_NOT_FOUND")
        return { kind: "not-found", target: saved.target };
      throw failure(error);
    }
  }
  async function run(
    action: "inspect" | "request" | "resume" | "cancel",
    record: NativeIntakeBrowserRecord,
    signal?: AbortSignal
  ): Promise<NativeExecutionObservation> {
    // Detach before the first asynchronous journal or network boundary. Two tabs or a double
    // click that both read "absent" and both start get one execution: the host joins a start
    // of the same attempt to the delivery in flight and answers a later one from its record.
    return perform(action, structuredClone(record), signal);
  }
  async function perform(
    action: "inspect" | "request" | "resume" | "cancel",
    original: NativeIntakeBrowserRecord,
    signal?: AbortSignal
  ): Promise<NativeExecutionObservation> {
    const found = await target(original, signal);
    if (!found) return { kind: "not-requested" };
    const { saved, stored } = found;
    if (action === "inspect") return status(saved, signal);
    // Saved once, when the target is first derived from the daemon; the write is durable when it returns.
    if (!stored) {
      current(signal);
      await options.journal.save(saved);
      current(signal);
    }
    let operation: "start" | "resume" | "cancel";
    if (action === "cancel") operation = "cancel";
    else {
      const observed = await status(saved, signal);
      if (action === "request") {
        // Only the exact typed absence permits one start. Unknown, pending,
        // refused and interrupted intents are never implicitly retried/resumed.
        if (observed.kind !== "not-found") return observed;
        operation = "start";
      } else {
        if (observed.kind !== "recorded" || !nativeExecutionCanResume(observed.snapshot))
          return observed;
        if (!sameRevision(saved.target.expectedRevision, observed.snapshot.expectedRevision))
          throw new Error(
            "The work changed since this browser saw it, so it was not picked up again. Look at it again in Work and try once more."
          );
        operation = "resume";
      }
    }
    try {
      const snapshot = await options.client[operation](saved.target, { signal });
      current(signal);
      return { kind: "recorded", target: saved.target, snapshot };
    } catch (error) {
      current(signal);
      // A mutation may have committed. Leave its durable identity intact; only
      // an explicit status/continue action can reconcile it. Never retry here.
      throw failure(error);
    }
  }
  return Object.freeze({
    inspect: (record: NativeIntakeBrowserRecord, signal?: AbortSignal) =>
      run("inspect", record, signal),
    request: (record: NativeIntakeBrowserRecord, signal?: AbortSignal) =>
      run("request", record, signal),
    resume: (record: NativeIntakeBrowserRecord, signal?: AbortSignal) =>
      run("resume", record, signal),
    cancel: (record: NativeIntakeBrowserRecord, signal?: AbortSignal) =>
      run("cancel", record, signal),
  });
}

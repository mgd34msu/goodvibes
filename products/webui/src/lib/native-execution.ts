import {
  nativeWorkExecutionIdentitySchema,
  type NativeWorkExecutionIdentity,
  type NativeWorkExecutionSnapshot,
  type OperatorNativeWorkExecutionClient,
} from "@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client";
import type { NativeConversationIntakeLookupResult } from "@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-intake-client";
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
  const messages: Record<string, string> = {
    NATIVE_EXECUTION_UNSUPPORTED_AUTHORITY:
      "Native execution requires current paired admin authority with read:work-ledger and write:fleet.",
    PAIRED_OWNER_REQUIRED:
      "Native execution runs from the daemon's own machine or a paired device with owner access. Open the web app on that machine, or pair this browser (Settings, Devices and pairing), then retry.",
    FORBIDDEN:
      "This pairing lacks the access native execution needs (read:work-ledger and write:fleet). Pair this browser again with that access (Settings, Devices and pairing), then retry.",
    NATIVE_EXECUTION_REFUSED:
      "Jev refused native execution. No automatic retry or legacy execution was requested.",
    NATIVE_EXECUTION_STALE:
      "The native execution target is stale. Inspect the original attempt; its saved revisions are unchanged.",
    NATIVE_EXECUTION_CONFLICT:
      "The native execution target conflicts with recorded admission. Inspect the original attempt.",
    NATIVE_EXECUTION_RECOVERY_REQUIRED:
      "Native execution needs reconciliation of its original effects before recovery. No execution was replayed.",
  };
  return new Error(
    messages[code] ??
      "Native execution outcome is unknown or unavailable. Inspect the saved attempt before continuing; no automatic retry was sent."
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
        throw new Error("The saved execution target belongs to a different original request.");
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
            "Recorded native execution revisions differ from the saved target. Recovery was not requested."
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

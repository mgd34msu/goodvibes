/**
 * One status line for a request sent to the daemon, in the words a person reads,
 * and the one decision (if any) it is waiting on. Every line is computed from the
 * host's last answer; nothing here reads or writes.
 */
import type { NativeWorkExecutionSnapshot } from "@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-execution-client";
import type { NativeHostedTurnSnapshot } from "@goodvibes-jev/engine/platform/platform/hosted-sessions/native-turn-client";
import type { NativeIntakeResult } from "../../lib/native-intake";
import type { NativeExecutionObservation } from "../../lib/native-execution";
import type { NativeTurnObservation } from "../../lib/native-turn";

type ExecutionSnapshot = Extract<NativeWorkExecutionSnapshot, { kind: "execution" }>;
type SettlementReason = NonNullable<NonNullable<ExecutionSnapshot["settlement"]>["reason"]>;

const SETTLEMENT_REASONS: Record<SettlementReason, string> = {
  "artifact-outside-tree": "the work touched a file outside the project",
  "artifact-not-regular": "a changed path is not an ordinary file",
  "artifact-too-large": "a changed file is too large to check",
  "artifact-access-restricted": "a changed file cannot be read under the access rules",
  "artifact-access-revoked": "access to a changed file was withdrawn",
  "artifact-budget-exceeded": "the changes are too large to check",
  "not-applied": "a deliverable was not applied",
  "review-not-genuine": "the review could not be confirmed",
  "changed-during-verification": "files changed while they were being checked",
  cancelled: "the check was cancelled",
  "host-state": "the daemon's own state stopped the check",
  "verification-failed": "the work did not pass its checks",
};

const RUNNER_WORDS: Record<string, string> = {
  queued: "Waiting to start",
  shaping: "Planning",
  planning: "Planning",
  "checking-plan": "Checking the plan",
  running: "Working",
  judging: "Checking the work",
  fixing: "Fixing what the checks found",
  committing: "Saving the changes",
};

export function intakeStatusLine(result: NativeIntakeResult): string {
  switch (result.kind) {
    case "not-found":
      return "The daemon has no record of this message.";
    case "captured":
      return "Received. Deciding how to handle it.";
    case "processing":
      return result.recovery === "required"
        ? "Deciding how to handle it was interrupted."
        : "Received. Deciding how to handle it.";
    case "work":
      return "Accepted as work.";
    case "turn":
      return "Sent to the session.";
    case "blocked":
      return result.reason === "unsupported-source"
        ? "Not started: it needs a file or image that could not be read. Send it again with that content written in."
        : "Not started: it needs more context. Send it again with the missing details.";
    case "refused":
      return result.reason === "exhausted"
        ? "Not started: the daemon could not work out what to do. Rephrase it and send it again."
        : "Not started: the daemon declined it.";
    case "cancelled":
      return "Cancelled before anything started.";
  }
}

export function turnStatusLine(snapshot: NativeHostedTurnSnapshot): string {
  switch (snapshot.state) {
    case "queued":
      return "Waiting for the reply in progress to finish.";
    case "preparing":
      return "Starting the reply.";
    case "running":
      return "Replying.";
    case "cancelling":
      return "Stopping.";
    case "completed":
      return snapshot.sessionId ? "Replied. Open the session to read the reply." : "Replied.";
    case "failed":
      return `The reply failed: ${snapshot.failure?.summary ?? "the model returned an error"}.${snapshot.failure?.retryable ? " Nothing was changed." : ""}`;
    case "cancelled":
      return "Cancelled. Anything already done stays done.";
    case "recovery-required":
      return "The process running this reply stopped, so its outcome is unknown.";
  }
}

export function executionStatusLine(snapshot: NativeWorkExecutionSnapshot): string {
  if (snapshot.kind === "prevented-before-admission") return "Cancelled before the work started.";
  if (snapshot.kind === "pending-intent") {
    if (snapshot.state === "refused") return "The work was not started: the daemon declined it.";
    return snapshot.recovery === "required" ? "Starting the work was interrupted." : "Starting the work.";
  }
  if (snapshot.state === "cancelled" || snapshot.recovery === "cancelled")
    return "Cancelled. Anything already done stays done.";
  const settlement = snapshot.settlement;
  if (settlement?.state === "published") return "Done. The result was checked and recorded.";
  if (snapshot.recovery === "required" && snapshot.state === "launch-claimed")
    return "The process running this work stopped, so its outcome is unknown.";
  if (snapshot.state === "prepared" && ["available", "required"].includes(snapshot.recovery))
    return "Starting the work was interrupted before it ran.";
  const progress = snapshot.progress;
  if (progress?.status === "passed") {
    if (settlement?.state === "failed")
      return `Finished, but the result did not pass its final check: ${settlement.reason ? SETTLEMENT_REASONS[settlement.reason] : "the check failed"}.`;
    return "Finished. Checking the result.";
  }
  if (progress?.status === "failed") return "The work failed.";
  if (progress?.status === "cancelled") return "Cancelled. Anything already done stays done.";
  if (progress?.status === "awaiting-owner") return "Waiting for you: the work has a question. Open it from the Work list to answer.";
  if (!progress) return "Started.";
  const words = RUNNER_WORDS[progress.status] ?? "Working";
  const steps = progress.units.total > 0 ? `: ${progress.units.passed} of ${progress.units.total} steps done` : "";
  return `${words}${steps}${progress.retrying ? " (waiting to reconnect)" : ""}.`;
}

/** The latest answer about one request, as one line. */
export function requestStatusLine(
  result: NativeIntakeResult | undefined,
  turn: NativeTurnObservation | undefined,
  execution: NativeExecutionObservation | undefined
): string {
  if (execution?.kind === "recorded") return executionStatusLine(execution.snapshot);
  if (turn?.kind === "recorded") return turnStatusLine(turn.snapshot);
  if (result?.kind === "work") return "Accepted as work. Starting it.";
  if (result?.kind === "turn") return "Sent to the session. Starting the reply.";
  if (result) return intakeStatusLine(result);
  return "Checking with the daemon.";
}

/** True while the host is still moving this request forward by itself. */
export function requestIsMoving(
  result: NativeIntakeResult | undefined,
  turn: NativeTurnObservation | undefined,
  execution: NativeExecutionObservation | undefined
): boolean {
  if (execution?.kind === "recorded") {
    const snapshot = execution.snapshot;
    if (snapshot.kind === "prevented-before-admission") return false;
    if (snapshot.kind === "pending-intent") return snapshot.state === "admitting" && snapshot.recovery === "pending";
    if (snapshot.state === "cancelled" || snapshot.recovery === "cancelled" || snapshot.recovery === "required") return false;
    if (snapshot.settlement?.state === "published" || snapshot.settlement?.state === "failed") return false;
    if (snapshot.state === "prepared") return false;
    const status = snapshot.progress?.status;
    if (status === "failed" || status === "cancelled") return false;
    return status !== "passed" || snapshot.settlement?.state === "pending";
  }
  if (turn?.kind === "recorded")
    return ["queued", "preparing", "running", "cancelling"].includes(turn.snapshot.state);
  if (result?.kind === "captured") return true;
  if (result?.kind === "processing") return result.recovery !== "required";
  return false;
}

/**
 * Finished for good: nothing more will happen and nothing is waiting on a decision,
 * so this browser no longer needs to keep the message.
 */
export function requestIsSettled(
  result: NativeIntakeResult | undefined,
  turn: NativeTurnObservation | undefined,
  execution: NativeExecutionObservation | undefined
): boolean {
  if (result?.kind === "blocked" || result?.kind === "refused" || result?.kind === "cancelled") return true;
  if (result?.kind === "turn" && turn?.kind === "recorded") {
    const { state, failure } = turn.snapshot;
    return state === "completed" || state === "cancelled" || (state === "failed" && failure?.retryable !== true);
  }
  if (result?.kind === "work" && execution?.kind === "recorded") {
    const snapshot = execution.snapshot;
    if (snapshot.kind === "prevented-before-admission") return true;
    if (snapshot.kind === "pending-intent") return snapshot.state === "refused";
    return (
      snapshot.state === "cancelled" ||
      snapshot.settlement?.state === "published" ||
      (snapshot.recovery === "terminal" && snapshot.progress?.status !== "passed")
    );
  }
  return false;
}

import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { NativeConversationIntakeUnsupportedSource, NativeSelectedDiffSelector } from "@goodvibes/engine/platform/platform/workflow/work-ledger/native-intake-client";
import { type ClientLifetime, isClientLifetimeCurrent } from "../../lib/client-lifetime";
import {
  openNativeIntake,
  type NativeIntakeResult,
  type NativeIntakeSession,
} from "../../lib/native-intake";
import {
  NativeIntakeBrowserJournalError,
  type NativeIntakeBrowserRecord,
} from "../../lib/native-intake-journal";
import { formatError } from "../../lib/errors";
import type { NativeExecutionObservation } from "../../lib/native-execution";
import type { NativeTurnObservation } from "../../lib/native-turn";
import { NativeExecutionStatus } from "./NativeExecutionStatus";
import { NativeTurnStatus } from "./NativeTurnStatus";
import { NativeReply } from "./NativeReply";
import {
  requestIsMoving,
  requestIsSettled,
  requestStatusLine,
  turnStatusLine,
} from "./native-request-status";
import { Button } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/ConfirmDialog";
import { Field, Input, Textarea } from "../../components/ui/Field";
import { Select } from "../../components/ui/Select";
import { Facts, DetailSection, Disclosure } from "../../components/data-view/DataView";

/** One message box: each message sent continues into work or a reply in its session. */
interface NativeIntakeFormProps {
  lifetime: ClientLifetime;
  onOpenSession?: (sessionId: string) => void;
  continuationSessionId?: string;
  selectedDiff?: NativeSelectedDiffSelector;
  projectId?: string;
  closed?: boolean;
  /** Text typed before the form was ready, carried into the message box. */
  initialText?: string;
}
/** How often a request the host is still moving is read again. */
const NATIVE_STATUS_REFRESH_MS = 5_000;
const MAX_TEXT = 20_000;

/** An error whose message already says what happened and what to do. */
class KnownOutcome extends Error {}

/**
 * read: a status read, superseded by any press. write: a step on the selected
 * message. send/cancel: supersede anything except a cancel already in flight
 * (sending a new message detaches the previous one's pending step, never cancels it).
 */
type RunMode = "write" | "read" | "send" | "cancel";

export function NativeIntakeForm(props: NativeIntakeFormProps) {
  return (
    <ScopedNativeIntakeForm
      key={JSON.stringify([
        props.lifetime.revision,
        props.continuationSessionId ?? null,
        props.selectedDiff ?? null,
        props.projectId ?? null,
      ])}
      {...props}
    />
  );
}

/** Never carry source, receipts or controls across a selected connection change. */
function ScopedNativeIntakeForm({
  lifetime,
  onOpenSession,
  continuationSessionId,
  selectedDiff,
  projectId,
  closed = false,
  initialText,
}: NativeIntakeFormProps) {
  const [text, setText] = useState(initialText ?? "");
  const [sources, setSources] = useState<NativeConversationIntakeUnsupportedSource[]>([]);
  const [records, setRecords] = useState<NativeIntakeBrowserRecord[]>([]);
  const [lines, setLines] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<NativeIntakeBrowserRecord>();
  const [result, setResult] = useState<NativeIntakeResult>();
  const [turn, setTurn] = useState<NativeTurnObservation>();
  const [turnError, setTurnError] = useState<string>();
  const [busy, setBusy] = useState<string>("Connecting");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [sendError, setSendError] = useState<string>();
  const [execution, setExecution] = useState<NativeExecutionObservation>();
  const [executionError, setExecutionError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [settleTried, setSettleTried] = useState<string>();
  // Saved in this browser under another pairing with this daemon and project: their text is
  // that pairing's, so only how many is shown; they stay for their owner.
  const [otherOwnerCount, setOtherOwnerCount] = useState(0);
  // Saved records this build cannot read; they cannot be shown or sent, only discarded.
  const [unreadableCount, setUnreadableCount] = useState(0);
  const confirm = useConfirm();
  const session = useRef<NativeIntakeSession | undefined>(undefined);
  const operation = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const busyRef = useRef(true);
  // A status read in flight never blocks a press: any action supersedes it.
  const reading = useRef(false);
  const cancelling = useRef(false);
  // Stages this page already carried forward once per message, so a failed step
  // turns into a "Needs you" action instead of being repeated on every refresh.
  const continued = useRef(new Set<string>());
  // Messages this page already asked the browser store to drop.
  const released = useRef(new Set<string>());
  // Bumped by "Retry connection": re-runs the connect effect after a failed connect,
  // which otherwise leaves the form gated on `ready` with nothing to press.
  const [connectAttempt, setConnectAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++generation.current;
    const current = () =>
      !controller.signal.aborted &&
      epoch === generation.current &&
      isClientLifetimeCurrent(lifetime);
    void (async () => {
      try {
        const connected = await openNativeIntake(
          lifetime,
          controller.signal,
          undefined,
          undefined,
          undefined,
          {
            continuationSessionId,
            selectedDiff,
            projectId,
          }
        );
        if (!current()) {
          connected.dispose();
          return;
        }
        session.current = connected;
        const saved = (await connected.list()).filter(
          (record) => record.command.continuation?.sessionId === continuationSessionId &&
            (!selectedDiff || JSON.stringify(record.command.continuation?.selectedDiff) === JSON.stringify(selectedDiff))
        );
        if (!current()) return;
        setRecords(saved);
        setReady(true);
        // Read beside the status below, never in its way: a failure here only leaves them unlisted.
        void Promise.all([connected.countOtherOwners(), connected.unreadable()]).then(
          ([others, unreadable]) => {
            if (!current()) return;
            setOtherOwnerCount(others);
            setUnreadableCount(unreadable);
          },
          () => undefined
        );
        // Reopening reads the latest message's status; the page carries it on from there.
        if (saved.length > 0) {
          const latest = [...saved].sort((a, b) => b.createdAt - a.createdAt)[0];
          setSelected(latest);
          reading.current = true;
          setBusy("");
          setRefreshing(true);
          const read = new AbortController();
          operation.current = read;
          await Promise.all([
            connected.inspect(latest, read.signal).then(
              (found) => {
                if (current()) setResult(found);
              },
              (cause: unknown) => {
                if (current()) setError(formatError(cause));
              }
            ),
            connected.turn.inspect(latest, read.signal).then(
              (found) => {
                if (current()) setTurn(found);
              },
              (cause: unknown) => {
                if (current()) setTurnError(formatError(cause));
              }
            ),
            connected.execution.inspect(latest, read.signal).then(
              (found) => {
                if (current()) setExecution(found);
              },
              (cause: unknown) => {
                if (current()) setExecutionError(formatError(cause));
              }
            ),
          ]);
        }
      } catch (cause) {
        if (current()) setError(formatError(cause));
      } finally {
        if (current()) {
          busyRef.current = false;
          reading.current = false;
          setRefreshing(false);
          setBusy("");
        }
      }
    })();
    return () => {
      controller.abort();
      operation.current?.abort();
      session.current?.dispose();
      session.current = undefined;
    };
  }, [lifetime, continuationSessionId, selectedDiff, projectId, connectAttempt]);

  const retryConnection = () => {
    if (ready || busyRef.current) return;
    busyRef.current = true;
    setError(undefined);
    setBusy("Connecting");
    setConnectAttempt((attempt) => attempt + 1);
  };

  const run = async (
    label: string,
    action: (
      connected: NativeIntakeSession,
      signal: AbortSignal,
      current: () => boolean
    ) => Promise<void>,
    mode: RunMode = "write"
  ) => {
    if (!session.current) return;
    const supersedes =
      reading.current || ((mode === "send" || mode === "cancel") && !cancelling.current);
    if (busyRef.current && !supersedes) return;
    busyRef.current = true;
    reading.current = mode === "read";
    cancelling.current = mode === "cancel";
    const epoch = ++generation.current;
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const current = () =>
      epoch === generation.current &&
      !controller.signal.aborted &&
      isClientLifetimeCurrent(lifetime);
    if (mode === "read") setRefreshing(true);
    else setBusy(label);
    setError(undefined);
    try {
      await action(session.current, controller.signal, current);
    } catch (cause) {
      if (current()) {
        setError(
          cause instanceof KnownOutcome
            ? cause.message
            : `${formatError(cause)} Whether it went through is not known yet. Check again before sending it again.`
        );
      }
    } finally {
      if (current()) {
        busyRef.current = false;
        reading.current = false;
        cancelling.current = false;
        setRefreshing(false);
        setBusy("");
      }
    }
  };
  const observeExecution = async (
    connected: NativeIntakeSession,
    record: NativeIntakeBrowserRecord,
    method: "inspect" | "request" | "resume" | "cancel",
    signal: AbortSignal,
    current: () => boolean
  ) => {
    if (!current()) return;
    setExecutionError(undefined);
    try {
      const found = await connected.execution[method](record, signal);
      if (current()) setExecution(found);
    } catch (cause) {
      if (current())
        setExecutionError(`${formatError(cause)} Whether the work started is not known yet.`);
    }
  };
  const observeTurn = async (
    connected: NativeIntakeSession,
    record: NativeIntakeBrowserRecord,
    method: "inspect" | "request" | "cancel",
    signal: AbortSignal,
    current: () => boolean
  ) => {
    if (!current()) return;
    setTurnError(undefined);
    try {
      const found = await connected.turn[method](record, signal);
      if (current()) setTurn(found);
    } catch (cause) {
      if (current())
        setTurnError(`${formatError(cause)} Whether the reply started is not known yet.`);
    }
  };
  const continueWork = async (
    connected: NativeIntakeSession,
    record: NativeIntakeBrowserRecord,
    found: NativeIntakeResult,
    signal: AbortSignal,
    current: () => boolean
  ) => {
    if (!current()) return;
    // Admission is already durable. Never erase its receipt if execution fails.
    setResult(found);
    const id = record.command.inputId;
    if (found.kind === "work") {
      continued.current.add(`${id}:execution-request`);
      setBusy("Starting the work");
      await observeExecution(connected, record, "request", signal, current);
    } else if (found.kind === "turn") {
      continued.current.add(`${id}:turn-request`);
      setBusy("Starting the reply");
      await observeTurn(connected, record, "request", signal, current);
    }
  };
  const clearObservations = () => {
    setResult(undefined);
    setTurn(undefined);
    setTurnError(undefined);
    setExecution(undefined);
    setExecutionError(undefined);
  };
  const inspect = (record: NativeIntakeBrowserRecord) => {
    if (busyRef.current && !reading.current) return;
    if (record.command.inputId !== selected?.command.inputId) clearObservations();
    setSelected(record);
    void run(
      "Checking",
      async (connected, signal, current) => {
        // Independent reads keep durable work controls reachable when intake
        // lookup is unavailable or its older source scope has become stale.
        await Promise.all([
          connected.inspect(record, signal).then(
            (found) => {
              if (current()) setResult(found);
            },
            (cause: unknown) => {
              if (current()) setError(formatError(cause));
            }
          ),
          observeExecution(connected, record, "inspect", signal, current),
          observeTurn(connected, record, "inspect", signal, current),
        ]);
      },
      "read"
    );
  };
  /** Drop every message the host reports finished; returns how many were dropped. */
  const releaseSettled = async (connected: NativeIntakeSession, signal: AbortSignal, current: () => boolean) => {
    const saved = [...(await connected.list()), ...(await connected.listOtherScopes())];
    let freed = 0;
    for (const record of saved) {
      if (!current()) break;
      const outcome = await connected.release(record, signal).catch(() => undefined);
      if (outcome?.released) {
        freed += 1;
        released.current.add(record.command.inputId);
      }
    }
    return freed;
  };
  const discardUnreadable = async () => {
    const ok = await confirm.ask({
      title: "Discard the unreadable saved messages?",
      description:
        "This version of the app cannot read them, so they cannot be shown or sent. They are removed from this browser only.",
      confirmLabel: "Discard",
      tone: "danger",
    });
    if (!ok) return;
    void run("Discarding", async (connected, _signal, current) => {
      try {
        await connected.discardUnreadable();
      } catch (cause) {
        throw new KnownOutcome(`The unreadable saved messages were not discarded: ${formatError(cause)}`);
      }
      const left = await connected.unreadable();
      if (current()) setUnreadableCount(left);
    });
  };
  const invalid =
    !text.trim() ||
    text.length > MAX_TEXT ||
    sources.some((source) => !source.label.trim() || source.label.length > 200);
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (closed || invalid || cancelling.current) return;
    const source = { text, unsupportedSources: sources };
    setSendError(undefined);
    void run("Sending", async (connected, signal, current) => {
      let original: NativeIntakeBrowserRecord | undefined;
      const saved = (record: NativeIntakeBrowserRecord) => {
        original = record;
        if (!current()) return;
        setSelected(record);
        clearObservations();
        setRecords((items) => [...items, record]);
        setText("");
        setSources([]);
      };
      let found: NativeIntakeResult;
      try {
        try {
          found = await connected.submit(source, saved, signal);
        } catch (cause) {
          if (original || !(cause instanceof NativeIntakeBrowserJournalError && cause.code === "capacity"))
            throw cause;
          // The browser keeps a message only until the daemon has finished with it.
          // A full store usually holds finished ones nobody looked at again: drop
          // those and send once more; still-running ones are never dropped.
          const freed = await releaseSettled(connected, signal, current);
          if (!current()) return;
          if (freed === 0)
            throw new KnownOutcome(
              "Not sent: this browser is already holding as many messages as it can while they are in progress. Send it again when one of them finishes."
            );
          found = await connected.submit(source, saved, signal);
        }
      } catch (cause) {
        if (original) throw cause;
        if (current())
          setSendError(cause instanceof KnownOutcome ? cause.message : `Not sent: ${formatError(cause)} Your text is still in the box.`);
        return;
      }
      if (original) await continueWork(connected, original, found, signal, current);
    }, "send");
  };
  const executionAction = (method: "inspect" | "request" | "resume" | "cancel") => {
    const record = selected;
    if (!record || (closed && method !== "inspect" && method !== "cancel")) return;
    const labels = {
      inspect: "Checking",
      request: "Starting the work",
      resume: "Continuing the work",
      cancel: "Cancelling",
    };
    void run(
      labels[method],
      (connected, signal, current) => observeExecution(connected, record, method, signal, current),
      method === "cancel" ? "cancel" : method === "inspect" ? "read" : "write"
    );
  };
  const turnAction = (method: "inspect" | "request" | "cancel") => {
    const record = selected;
    if (!record || (closed && method !== "inspect" && method !== "cancel")) return;
    const labels = {
      inspect: "Checking",
      request: "Starting the reply",
      cancel: "Cancelling",
    };
    void run(
      labels[method],
      (connected, signal, current) => observeTurn(connected, record, method, signal, current),
      method === "cancel" ? "cancel" : method === "inspect" ? "read" : "write"
    );
  };
  const retrySubmission = () => {
    const record = selected;
    if (!record || closed) return;
    void run("Sending", async (connected, signal, current) =>
      continueWork(connected, record, await connected.retry(record, signal), signal, current)
    );
  };
  const resumeIntake = () => {
    const record = selected;
    if (!record || closed) return;
    void run("Continuing", async (connected, signal, current) =>
      continueWork(connected, record, await connected.resume(record, signal), signal, current)
    );
  };
  const cancelIntake = () => {
    const record = selected;
    if (!record) return;
    void run(
      "Cancelling",
      async (connected, signal, current) => {
        const found = await connected.cancel(record, signal);
        if (!current()) return;
        setResult(found);
        // A cancellation race may reveal admitted work. Read it;
        // cancellation must never become a new execution request.
        if (found.kind === "work")
          await observeExecution(connected, record, "inspect", signal, current);
        else if (found.kind === "turn")
          await observeTurn(connected, record, "inspect", signal, current);
      },
      "cancel"
    );
  };

  const executionSnapshot = execution?.kind === "recorded" ? execution.snapshot : undefined;
  const executionRecord = executionSnapshot?.kind === "execution" ? executionSnapshot : undefined;
  const turnSnapshot = turn?.kind === "recorded" ? turn.snapshot : undefined;
  const moving = Boolean(selected) && !error && requestIsMoving(result, turn, execution);
  const settled = requestIsSettled(result, turn, execution);
  const idle = !busy && !refreshing;

  // The status keeps itself current: while the host is still moving the selected
  // message, it is read again every few seconds (one read in flight at a time).
  useEffect(() => {
    if (!moving || !idle || !selected) return;
    const record = selected;
    const timer = setTimeout(() => {
      if (!busyRef.current) inspect(record);
    }, NATIVE_STATUS_REFRESH_MS);
    return () => clearTimeout(timer);
    // `inspect` is recreated each render; the timer re-arms after every answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving, idle, selected, result, turn, execution]);

  // Carry the message on by itself: each step the host leaves for its client
  // (finish intake, start the work or reply, check a finished result) runs once.
  useEffect(() => {
    if (!selected || !idle || closed || error) return;
    const id = selected.command.inputId;
    const once = (stage: string, act: () => void) => {
      const key = `${id}:${stage}`;
      if (continued.current.has(key)) return;
      continued.current.add(key);
      act();
    };
    if (result?.kind === "captured") once("intake", retrySubmission);
    else if (result?.kind === "work" && execution?.kind === "not-found" && !executionError)
      once("execution-request", () => executionAction("request"));
    else if (result?.kind === "turn" && turn?.kind === "not-found" && !turnError)
      once("turn-request", () => turnAction("request"));
    else if (executionRecord?.progress?.status === "passed" && executionRecord.settlement?.state === "required")
      once("settle", () => {
        setSettleTried(id);
        executionAction("resume");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, idle, closed, error, result, turn, execution, executionError, turnError]);

  // A finished message no longer needs to be kept in this browser.
  useEffect(() => {
    if (!selected || !idle || !settled) return;
    const record = selected;
    const id = record.command.inputId;
    if (released.current.has(id)) return;
    released.current.add(id);
    void session.current?.release(record).catch(() => undefined);
  }, [selected, idle, settled]);

  // Each row keeps the last status line read for it.
  useEffect(() => {
    if (!selected || (!result && !turn && !execution)) return;
    const id = selected.command.inputId;
    const line = requestStatusLine(result, turn, execution);
    setLines((known) => (known[id] === line ? known : { ...known, [id]: line }));
  }, [selected, result, turn, execution]);

  const hasTurnTarget = turn !== undefined && turn.kind !== "not-requested";
  const hasExecutionTarget = execution !== undefined && execution.kind !== "not-requested";
  const intakeTerminal =
    result !== undefined && ["work", "turn", "blocked", "refused", "cancelled"].includes(result.kind);
  const executionCancelled =
    executionSnapshot?.kind === "prevented-before-admission" || executionSnapshot?.state === "cancelled";
  const turnFinished =
    turnSnapshot?.state === "completed" || turnSnapshot?.state === "cancelled" || turnSnapshot?.state === "failed";
  const cancelTarget: "execution" | "turn" | "intake" | undefined = !selected || settled
    ? undefined
    : result?.kind === "work" || hasExecutionTarget
      ? (executionCancelled ? undefined : "execution")
      : result?.kind === "turn" || hasTurnTarget
        ? (turnFinished || turn?.kind === "not-requested" ? undefined : "turn")
        : intakeTerminal
          ? undefined
          : "intake";
  const cancel = () => {
    if (cancelTarget === "execution") executionAction("cancel");
    else if (cancelTarget === "turn") turnAction("cancel");
    else if (cancelTarget === "intake") cancelIntake();
  };
  const check = () => {
    if (selected) inspect(selected);
  };
  const executionResumable = Boolean(
    executionSnapshot &&
    !executionSnapshot.stale &&
    executionSnapshot.currentAttempt &&
    ((executionSnapshot.kind === "pending-intent" && executionSnapshot.recovery === "required") ||
      (executionSnapshot.kind === "execution" &&
        executionSnapshot.state === "prepared" &&
        ["available", "required"].includes(executionSnapshot.recovery)))
  );
  const executionCanRequest = result?.kind === "work" && (!execution || execution.kind === "not-found");
  const turnCanRequest = result?.kind === "turn" && (!turn || turn.kind === "not-found");

  // At most one decision is offered, and only when the host cannot go on without one.
  let need: { reason: string; label: string; act: () => void; sends: boolean } | undefined;
  if (!selected) need = undefined;
  else if (error) need = { reason: error, label: "Check again", act: check, sends: false };
  else if (executionError)
    need = executionCanRequest
      ? { reason: executionError, label: "Try again", act: () => executionAction("request"), sends: true }
      : { reason: executionError, label: "Check again", act: check, sends: false };
  else if (turnError)
    need = turnCanRequest
      ? { reason: turnError, label: "Try again", act: () => turnAction("request"), sends: true }
      : { reason: turnError, label: "Check again", act: check, sends: false };
  else if (result?.kind === "not-found")
    need = { reason: "The daemon has no record of this message.", label: "Send it", act: retrySubmission, sends: true };
  else if (result?.kind === "processing" && result.recovery === "required")
    need = { reason: "Deciding how to handle this message was interrupted.", label: "Continue", act: resumeIntake, sends: true };
  else if (turnSnapshot?.state === "failed" && turnSnapshot.failure?.retryable)
    need = { reason: turnStatusLine(turnSnapshot), label: "Send again", act: () => turnAction("request"), sends: true };
  else if (turnSnapshot?.state === "recovery-required")
    need = {
      reason: "The process running this reply stopped, so its outcome is unknown. Cancel it to free the session; it will not be run again.",
      label: "Cancel it",
      act: cancel,
      sends: false,
    };
  else if (executionResumable)
    need = { reason: "Starting the work was interrupted.", label: "Resume", act: () => executionAction("resume"), sends: true };
  else if (executionRecord?.progress?.status === "passed" && executionRecord.settlement?.state === "failed")
    need = { reason: requestStatusLine(result, turn, execution), label: "Check the result again", act: () => executionAction("resume"), sends: true };
  else if (
    executionRecord?.progress?.status === "passed" &&
    executionRecord.settlement?.state === "required" &&
    settleTried === selected.command.inputId &&
    idle
  )
    need = { reason: "The finished work has not been checked yet.", label: "Check the result", act: () => executionAction("resume"), sends: true };
  else if (executionRecord?.recovery === "required" && executionRecord.state === "launch-claimed")
    need = {
      reason: "The process running this work stopped, so its outcome is unknown. Cancel it to free it; it will not be run again.",
      label: "Cancel it",
      act: cancel,
      sends: false,
    };
  const needCancels = need?.act === cancel;
  const sessionId = turnSnapshot?.sessionId;
  const rows = [...records].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="work-form native-intake">
      <p className="dv-muted">
        Your message is kept in this browser until the daemon has it. Closing this page does not
        stop anything already sent.
      </p>
      {!selected && error && <p role="alert">{error}</p>}
      {busy && <p role="status">{busy}…</p>}
      {!ready && !busy && (
        <Button type="button" onClick={retryConnection}>
          Retry connection
        </Button>
      )}
      {closed && <p role="status">This session is closed. Reopen it to send another message.</p>}
      {ready && !closed && (
        <form className="work-form" onSubmit={submit}>
          <Field
            label={selectedDiff ? "Comment" : "Message"}
            help="Sent exactly as written, up to 20,000 characters."
          >
            <Textarea
              autoFocus
              rows={4}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setSendError(undefined);
              }}
            />
          </Field>
          {text.length > MAX_TEXT && (
            <p role="alert">
              The message is longer than 20,000 characters. Nothing will be cut or sent.
            </p>
          )}
          {sendError && <p role="alert">{sendError}</p>}
          {sources.map((source, index) => (
            <div className="work-form__pair" key={index}>
              <Field label={`Missing item ${index + 1}`}>
                <Select
                  value={source.kind}
                  options={[
                    { value: "context", label: "Missing details" },
                    { value: "file", label: "A file I could not include" },
                    { value: "image", label: "An image I could not include" },
                  ]}
                  onChange={(kind: NativeConversationIntakeUnsupportedSource["kind"]) =>
                    setSources((items) =>
                      items.map((item, i) => (i === index ? { ...item, kind } : item))
                    )
                  }
                />
              </Field>
              <Field
                label={`Missing item ${index + 1} description`}
                error={
                  source.label.length > 200
                    ? "At most 200 characters. Nothing will be cut."
                    : undefined
                }
              >
                <Input
                  value={source.label}
                  onChange={(event) =>
                    setSources((items) =>
                      items.map((item, i) =>
                        i === index ? { ...item, label: event.target.value } : item
                      )
                    )
                  }
                />
              </Field>
              <Button
                type="button"
                onClick={() => setSources((items) => items.filter((_, i) => i !== index))}
              >
                Remove missing item {index + 1}
              </Button>
            </div>
          ))}
          <div className="work-form__actions">
            <Button
              type="button"
              disabled={sources.length >= 100}
              onClick={() => setSources((items) => [...items, { kind: "context", label: "" }])}
            >
              Note something missing
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy === "Connecting" || busy.startsWith("Cancelling") || invalid}
            >
              Send
            </Button>
          </div>
        </form>
      )}
      {rows.length > 0 && (
        <DetailSection title="Sent">
          <ul className="native-intake__saved">
            {rows.map((record) => {
              const id = record.command.inputId;
              return (
                <li key={id}>
                  <Button
                    disabled={Boolean(busy)}
                    aria-pressed={selected?.command.inputId === id}
                    onClick={() => {
                      // Tapping a message asks again: its next step may run once more.
                      for (const key of [...continued.current])
                        if (key.startsWith(`${id}:`)) continued.current.delete(key);
                      inspect(record);
                    }}
                    aria-label={`Show message ${id}`}
                  >
                    {record.command.text.slice(0, 80)}
                    {record.command.text.length > 80 ? "…" : ""}
                  </Button>
                  {/* The open message states its status below, with its actions. */}
                  {selected?.command.inputId !== id && (
                    <span className="dv-muted">
                      {lines[id] ?? `Sent ${new Date(record.createdAt).toLocaleString()}.`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </DetailSection>
      )}
      {otherOwnerCount > 0 && (
        <DetailSection title="Saved under another pairing">
          <p className="dv-muted">
            {otherOwnerCount === 1
              ? "One message for this daemon and project was saved in this browser under another pairing."
              : `${otherOwnerCount} messages for this daemon and project were saved in this browser under another pairing.`}{" "}
            Their text belongs to that pairing and is not shown here. Sign in as that pairing to
            recover them; they stay in this browser for it.
          </p>
        </DetailSection>
      )}
      {unreadableCount > 0 && (
        <DetailSection title="Unreadable saved messages">
          <p className="dv-muted">
            {unreadableCount === 1
              ? "One saved message in this browser cannot be read by this version of the app, so it cannot be shown or sent."
              : `${unreadableCount} saved messages in this browser cannot be read by this version of the app, so they cannot be shown or sent.`}
          </p>
          <Button size="sm" disabled={Boolean(busy)} onClick={() => void discardUnreadable()}>
            Discard them
          </Button>
        </DetailSection>
      )}
      {confirm.element}
      {selected && (
        <section className="native-intake__request" aria-label="Selected message">
          {/* The row above shows the first 80 characters; the whole text only when it was cut. */}
          {selected.command.text.length > 80 && <pre className="native-intake__source">{selected.command.text}</pre>}
          {selected.command.unsupportedSources.length > 0 && (
            <ul>
              {selected.command.unsupportedSources.map((source, index) => (
                <li key={index}>
                  Missing {source.kind === "context" ? "details" : source.kind}: {source.label}
                </li>
              ))}
            </ul>
          )}
          <p role="status">{requestStatusLine(result, turn, execution)}</p>
          {turnSnapshot?.state === "completed" && turnSnapshot.sessionId && (
            <NativeReply sessionId={turnSnapshot.sessionId} turnKey={turnSnapshot.correlationId ?? turnSnapshot.inputId} />
          )}
          {need && (
            <div className="native-intake__needs">
              <p role="alert">Needs you: {need.reason}</p>
              <Button
                variant="primary"
                disabled={(need.act === cancel ? busy.startsWith("Cancelling") : Boolean(busy)) || (need.sends && closed)}
                onClick={need.act}
              >
                {need.label}
              </Button>
            </div>
          )}
          <div className="work-form__actions">
            {cancelTarget && !needCancels && (
              <Button
                disabled={busy.startsWith("Cancelling") || busy === "Connecting"}
                onClick={cancel}
              >
                Cancel
              </Button>
            )}
            {sessionId && onOpenSession && (
              <Button
                onClick={() => {
                  if (isClientLifetimeCurrent(lifetime)) onOpenSession(sessionId);
                }}
              >
                Open the session
              </Button>
            )}
          </div>
          {result?.kind === "work" && result.receipt.criteria.length > 0 && (
            <DetailSection title="What will be checked">
              <ol>
                {result.receipt.criteria.map((criterion, index) => (
                  <li className="native-intake__source" key={index}>
                    {criterion}
                  </li>
                ))}
              </ol>
            </DetailSection>
          )}
          <Disclosure summary="Details">
            <Facts
              items={[
                { label: "Input", value: selected.command.inputId },
                { label: "Request", value: selected.command.requestId },
                ...(selected.command.continuation
                  ? [{ label: "Session", value: selected.command.continuation.sessionId }]
                  : []),
                ...(result && result.kind !== "not-found" && result.sourceRef.continuation
                  ? [{ label: "Conversation revision", value: result.sourceRef.continuation.revision }]
                  : []),
                ...(selected.command.continuation?.selectedDiff ? [
                  { label: "Commented change", value: selected.command.continuation.selectedDiff.kind === "session" ? "This session's changes" : "Workspace changes since a checkpoint" },
                  { label: "Change revision", value: selected.command.continuation.selectedDiff.revision },
                  { label: "File / hunk", value: `${selected.command.continuation.selectedDiff.fileIndex + 1} / ${selected.command.continuation.selectedDiff.hunkIndex + 1}` },
                ] : []),
                ...(result && result.kind !== "not-found"
                  ? [{ label: "Source revision", value: result.sourceRef.sourceRevision }]
                  : []),
                ...(result?.kind === "work"
                  ? [{ label: "Admission decision", value: result.receipt.source.admissionDecisionId }]
                  : []),
              ]}
            />
            <NativeExecutionStatus observation={execution} />
            <NativeTurnStatus observation={turn} />
          </Disclosure>
        </section>
      )}
    </div>
  );
}

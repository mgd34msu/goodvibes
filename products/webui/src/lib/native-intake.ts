import type { OperatorRemoteClient } from "@goodvibes/engine/operator-client";
import { createOperatorNativeWorkExecutionClient } from "@goodvibes/engine/platform/platform/workflow/work-ledger/native-execution-client";
import {
  createOperatorNativeConversationIntakeClient,
  nativeConversationIntakeCaptureRequestSchema,
  nativeSelectedDiffSelectorSchema,
  type NativeConversationIntakeLookupResult,
  type NativeConversationIntakeUnsupportedSource,
  type NativeSelectedDiffSelector,
} from "@goodvibes/engine/platform/platform/workflow/work-ledger/native-intake-client";
import { GOODVIBES_BASE_URL, client as platformClient, type OperatorMethodId, type OperatorMethodInput } from "./goodvibes";
import {
  isClientLifetimeCurrent,
  subscribeClientLifetime,
  type ClientLifetime,
} from "./client-lifetime";
import { getActiveRoute } from "./relay-connection";
import { getStoredRelayPairing } from "./relay-pairing";
import { randomUuid } from "./uuid";
import { createNativeIntakeExecution, nativeExecutionCanResume } from "./native-execution";
import { createNativeIntakeTurn } from "./native-turn";
import {
  createNativeExecutionBrowserJournal,
  type NativeExecutionBrowserJournal,
} from "./native-execution-journal";
import {
  createNativeIntakeBrowserJournal,
  type NativeIntakeBrowserBinding,
  type NativeIntakeBrowserRecord,
} from "./native-intake-journal";

export type NativeIntakeResult = NativeConversationIntakeLookupResult;
export interface NativeIntakeSource {
  text: string;
  unsupportedSources: NativeConversationIntakeUnsupportedSource[];
  /** Files already stored with `artifacts.create`, sent by their ids (1 to 8). */
  attachments?: { artifactId: string; label?: string }[];
}
export interface NativeIntakeScope {
  continuationSessionId?: string;
  /** Host-resolved evidence selector, never browser-authored source text or authority. */
  selectedDiff?: NativeSelectedDiffSelector;
  /** Verified discovery result. Reopening must not silently adopt a different project. */
  projectId?: string;
}
export type NativeIntakeJournal = ReturnType<typeof createNativeIntakeBrowserJournal>;
const terminal = (result: NativeIntakeResult) =>
  ["work", "turn", "blocked", "refused", "cancelled"].includes(result.kind);
/** The owner of a saved request: daemon, project and paired principal. The route it was sent over is not part of it. */
const sameBinding = (left: NativeIntakeBrowserBinding, right: NativeIntakeBrowserBinding) =>
  left.endpoint === right.endpoint && left.projectId === right.projectId && left.principalId === right.principalId;

/** A selected browser identity is a fence, never a native authority grant. */
export async function openNativeIntake(
  lifetime: ClientLifetime,
  signal: AbortSignal,
  journal: NativeIntakeJournal = createNativeIntakeBrowserJournal(),
  newId: () => string = randomUuid,
  executionJournal: NativeExecutionBrowserJournal = createNativeExecutionBrowserJournal(),
  scope: NativeIntakeScope = {}
) {
  const { continuationSessionId, projectId: expectedProjectId } = scope;
  const selectedDiff = scope.selectedDiff ? nativeSelectedDiffSelectorSchema.parse(scope.selectedDiff) : undefined;
  if (selectedDiff && !continuationSessionId)
    throw new Error("A selected change requires a verified native session.");
  const continuation =
    continuationSessionId === undefined ? undefined : { sessionId: continuationSessionId, ...(selectedDiff ? { selectedDiff } : {}) };
  if (continuation)
    nativeConversationIntakeCaptureRequestSchema.parse({
      requestId: "validation",
      inputId: "validation",
      text: "validation",
      unsupportedSources: [],
      continuation,
    });
  let disposed = false;
  const lifetimeAbort = new AbortController();
  const stop = () => lifetimeAbort.abort();
  const unsubscribe = subscribeClientLifetime(stop);
  signal.addEventListener("abort", stop, { once: true });
  const check = () => {
    if (
      disposed ||
      signal.aborted ||
      lifetimeAbort.signal.aborted ||
      !isClientLifetimeCurrent(lifetime)
    ) {
      throw new Error("The connection to the daemon changed meanwhile. Open the request again to see where it stands.");
    }
  };
  const combined = (operation?: AbortSignal) =>
    AbortSignal.any([signal, lifetimeAbort.signal, ...(operation ? [operation] : [])]);
  const readBinding = async (
    operation?: AbortSignal,
    authority: "intake" | "execution" | "turn" = "intake"
  ): Promise<NativeIntakeBrowserBinding> => {
    check();
    const current = combined(operation);
    current.throwIfAborted();
    const auth = await platformClient.operator.invoke("control.auth.current", {}, current);
    check();
    current.throwIfAborted();
    // The daemon says whether this browser is the owner himself (his sign-in with his
    // name and password): its one test of who the owner is, never guessed here.
    // A device he paired is not him, but does his native work (method-owner-decision.ts
    // `ownersDevice`), so a paired browser keeps the form.
    const owner =
      (auth as { readonly ownerHimself?: unknown }).ownerHimself === true ||
      (auth as { readonly credential?: unknown }).credential === "device-token";
    if (
      !auth.authenticated ||
      !auth.admin ||
      !owner ||
      !auth.principalId ||
      auth.principalId.length > 200 ||
      !(
        authority === "turn"
          ? ["read:work-ledger", "write:work-ledger", "write:sessions"]
          : ["read:work-ledger", authority === "execution" ? "write:fleet" : "write:work-ledger"]
      ).every((scope) => auth.scopes.includes("*") || auth.scopes.includes(scope))
    ) {
      const feature =
        // Said to a person: what he was doing, never the transport's name.
        authority === "turn" ? "Sending a message to the daemon" : authority === "execution" ? "Running work on the daemon" : "Asking for work";
      throw Object.assign(
        new Error(
          owner
            ? `${feature} needs full access, and this browser's pairing does not have it. Pair it again with full access (Settings, Devices and pairing), then try again.`
            : `${feature} is for the owner: sign in with the owner's name and password, or pair this browser (Settings, Devices and pairing), then try again.`
        ),
        { code: "PAIRED_OWNER_REQUIRED" }
      );
    }
    const diffScope = selectedDiff?.kind === "session" ? "read:sessions" : selectedDiff ? "read:checkpoints" : undefined;
    if (diffScope && !auth.scopes.includes("*") && !auth.scopes.includes(diffScope))
      throw new Error(`Sending a chosen change needs access to read ${diffScope === "read:sessions" ? "conversations" : "checkpoints"}, and this browser does not have it. Pair it again with full access (Settings, Devices and pairing).`);
    const project = await platformClient.operator.invoke("workLedger.project", {}, current);
    check();
    current.throwIfAborted();
    if (
      typeof project.projectId !== "string" ||
      !project.projectId ||
      project.projectId.length > 200
    )
      throw new Error("The daemon did not say which project the work is for, so nothing was sent.");
    if (expectedProjectId !== undefined && project.projectId !== expectedProjectId)
      throw new Error("The conversation's project changed meanwhile. Open the conversation again before sending.");
    const relay = getActiveRoute() === "relay" ? getStoredRelayPairing() : null;
    if (getActiveRoute() === "relay" && !relay)
      throw new Error("The connection through the relay is not set up in this browser, so nothing was sent.");
    // Only the public host key is retained. No token, relay rendezvous or grant.
    return {
      endpoint: GOODVIBES_BASE_URL,
      projectId: project.projectId,
      principalId: auth.principalId,
      transport: relay ? `relay:${relay.daemonPublicKey}` : "direct",
    };
  };
  try {
    // The binding is read once, when the form opens. After that the daemon's answer to each
    // real call is the authority check (it refuses another principal or project with a typed
    // code), and a changed sign-in closes this form through the client-lifetime subscription.
    const binding = await readBinding(undefined, continuation ? "turn" : "intake");
    // The native clients call only contract method ids, so each call keeps its typed body.
    const invoke = (async <TMethodId extends OperatorMethodId>(
      method: TMethodId,
      input?: OperatorMethodInput<TMethodId>,
      options?: { signal?: AbortSignal }
    ) => {
      check();
      const result = await platformClient.operator.invoke(method, input, combined(options?.signal));
      check();
      return result;
    }) as OperatorRemoteClient["invoke"];
    const client = createOperatorNativeConversationIntakeClient({ invoke }, binding.projectId);
    const executionClient = createOperatorNativeWorkExecutionClient({ invoke }, binding.projectId);
    const owned = (record: NativeIntakeBrowserRecord) => {
      check();
      if (!sameBinding(binding, record.binding))
        throw new Error("This request was saved under another sign-in, so it is left as it is.");
    };
    const inScope = (record: NativeIntakeBrowserRecord) =>
      record.command.continuation?.sessionId === continuationSessionId &&
      (!selectedDiff ||
        JSON.stringify(record.command.continuation?.selectedDiff) === JSON.stringify(selectedDiff));
    // The saved original is confirmed against the journal once per action, at its start;
    // later steps of the same action use the copy that was confirmed.
    const confirm = async (record: NativeIntakeBrowserRecord) => {
      owned(record);
      if (!inScope(record))
        throw new Error("This saved request belongs to another conversation or another chosen change, so it is left as it is.");
      await journal.confirm(record);
      check();
    };
    // Releasing must work from any form: the journal's capacity counts every saved original
    // for this owner, including those saved under other sessions or selected changes.
    const confirmOwned = async (record: NativeIntakeBrowserRecord) => {
      owned(record);
      await journal.confirm(record);
      check();
    };
    /**
     * The daemon's record of a saved original, checked against the saved copy. The engine
     * client checks later answers against what it has seen; a lookup is the first answer
     * after a reload, so this is where the saved copy is compared.
     */
    const lookup = async (record: NativeIntakeBrowserRecord, operation?: AbortSignal) => {
      const result = await client.get({ inputId: record.command.inputId }, { signal: combined(operation) });
      if (
        result.kind !== "not-found" &&
        (result.requestId !== record.command.requestId ||
          result.sourceRef.continuation?.sessionId !== record.command.continuation?.sessionId ||
          JSON.stringify(result.sourceRef.continuation?.selectedDiff) !== JSON.stringify(record.command.continuation?.selectedDiff) ||
          (result.kind === "turn" &&
            (result.text !== record.command.text ||
              result.continuation?.sessionId !== record.command.continuation?.sessionId ||
              result.continuation?.revision !== result.sourceRef.continuation?.revision)) ||
          (result.kind === "work" && result.receipt.goal !== record.command.text))
      ) {
        throw new Error(
          "The daemon's record of this request does not match what this browser saved, so nothing was sent. The saved request is kept to look at."
        );
      }
      return result;
    };
    const inspect = async (record: NativeIntakeBrowserRecord, operation?: AbortSignal) => {
      await confirm(record);
      return lookup(record, operation);
    };
    const inspectOwned = async (record: NativeIntakeBrowserRecord, operation?: AbortSignal) => {
      await confirmOwned(record);
      return lookup(record, operation);
    };
    const active = (operation?: AbortSignal) => {
      check();
      combined(operation).throwIfAborted();
    };
    const releaseExecution = createNativeIntakeExecution({
      binding, client: executionClient, journal: executionJournal, confirm: confirmOwned, inspect: lookup, active,
    });
    const releaseTurn = createNativeIntakeTurn({
      binding,
      invoke: (method, input, operation) => invoke(method, input, { signal: combined(operation) }),
      confirm: confirmOwned,
      inspect: lookup,
      active,
    });
    const execution = createNativeIntakeExecution({
      binding, client: executionClient, journal: executionJournal, confirm, inspect: lookup, active,
    });
    const turn = createNativeIntakeTurn({
      binding,
      invoke: (method, input, operation) => invoke(method, input, { signal: combined(operation) }),
      confirm,
      inspect: lookup,
      active,
    });
    const continueSubmission = async (
      record: NativeIntakeBrowserRecord,
      found: NativeIntakeResult,
      operation?: AbortSignal
    ): Promise<NativeIntakeResult> => {
      let result = found;
      if (result.kind === "not-found")
        result = await client.capture(record.command, { signal: combined(operation) });
      if (result.kind === "captured")
        result = await client.admit(
          { inputId: record.command.inputId, sourceRevision: result.sourceRef.sourceRevision },
          { signal: combined(operation) }
        );
      check();
      return result;
    };
    return {
      binding,
      execution,
      turn,
      async list() {
        check();
        const records = await journal.list(binding);
        check();
        return records.filter(inScope);
      },
      /** Saved originals for this owner that belong to other sessions or selected changes. They count toward the journal's capacity. */
      async listOtherScopes() {
        check();
        const records = await journal.list(binding);
        check();
        return records.filter((record) => !inScope(record));
      },
      /**
       * How many originals of this daemon and project were saved in this browser under another
       * pairing. Their text is that principal's: it is never listed here, and the records stay
       * for their owner, who recovers them by signing in as that pairing.
       */
      async countOtherOwners() {
        check();
        const count = await journal.countOthers(binding);
        check();
        return count;
      },
      /** How many saved records this build cannot read. */
      unreadable: () => journal.unreadable(),
      /** Delete the saved records this build cannot read; they cannot be inspected or sent. */
      discardUnreadable: () => journal.discardUnreadable(),
      async submit(
        source: NativeIntakeSource,
        saved: (record: NativeIntakeBrowserRecord) => void,
        operation?: AbortSignal
      ) {
        // Validate before allocating identities. Deliberate identical inputs still get new IDs.
        const original = nativeConversationIntakeCaptureRequestSchema.parse({
          requestId: "validation",
          inputId: "validation",
          ...source,
          ...(continuation ? { continuation } : {}),
        });
        check();
        const record = {
          binding,
          command: nativeConversationIntakeCaptureRequestSchema.parse({
            requestId: newId(),
            inputId: newId(),
            text: original.text,
            unsupportedSources: original.unsupportedSources,
            ...(original.attachments?.length ? { attachments: original.attachments } : {}),
            ...(original.continuation ? { continuation: original.continuation } : {}),
          }),
          createdAt: Date.now(),
        };
        await journal.save(record);
        check();
        saved(record);
        return continueSubmission(record, { kind: "not-found" }, operation);
      },
      inspect,
      async retry(record: NativeIntakeBrowserRecord, operation?: AbortSignal) {
        // Never repeat an uncertain mutation until authoritative lookup has answered.
        return continueSubmission(record, await inspect(record, operation), operation);
      },
      async resume(record: NativeIntakeBrowserRecord, operation?: AbortSignal) {
        const found = await inspect(record, operation);
        if (found.kind !== "processing" || found.recovery !== "required") return found;
        return client.resume(
          { inputId: record.command.inputId, sourceRevision: found.sourceRef.sourceRevision },
          { signal: combined(operation) }
        );
      },
      async cancel(record: NativeIntakeBrowserRecord, operation?: AbortSignal) {
        const found = await inspect(record, operation);
        if (found.kind === "not-found" || terminal(found)) return found;
        return client.cancel(
          { inputId: record.command.inputId, sourceRevision: found.sourceRef.sourceRevision },
          { signal: combined(operation) }
        );
      },
      /**
       * Retire a saved original that is no longer needed, to free room in this browser's
       * journal. Only when the daemon itself reports the request finished (nothing was
       * admitted, or its conversation turn or work execution reached a terminal state);
       * otherwise nothing is removed and the daemon's current answer comes back instead.
       */
      async release(record: NativeIntakeBrowserRecord, operation?: AbortSignal) {
        const found = await inspectOwned(record, operation);
        let settled = false;
        if (found.kind === "blocked" || found.kind === "refused" || found.kind === "cancelled") settled = true;
        else if (found.kind === "turn") {
          const observed = await releaseTurn.inspect(record, operation);
          settled =
            observed.kind === "recorded" &&
            (observed.snapshot.state === "completed" || observed.snapshot.state === "cancelled");
        } else if (found.kind === "work") {
          const observed = await releaseExecution.inspect(record, operation);
          settled =
            observed.kind === "recorded" &&
            observed.snapshot.kind === "execution" &&
            (observed.snapshot.state === "cancelled" || observed.snapshot.recovery === "terminal") &&
            !nativeExecutionCanResume(observed.snapshot);
        }
        if (!settled) return { released: false as const, result: found };
        // The execution target goes first: if retiring the original then fails, the
        // original is still there and the target is re-derived from the daemon.
        const target = await executionJournal.get(binding, record.command.inputId);
        if (target) await executionJournal.remove(target);
        await journal.remove(record);
        check();
        return { released: true as const, result: found };
      },
      dispose() {
        disposed = true;
        stop();
        client.dispose();
        executionClient.dispose();
        unsubscribe();
        signal.removeEventListener("abort", stop);
      },
    };
  } catch (error) {
    unsubscribe();
    signal.removeEventListener("abort", stop);
    stop();
    throw error;
  }
}

export type NativeIntakeSession = Awaited<ReturnType<typeof openNativeIntake>>;

/** The protocol discriminators are factual lifecycle states, not prose classifiers. */
export function nativeIntakeDescription(result: NativeIntakeResult): string {
  switch (result.kind) {
    case "not-found":
      return "The latest lookup found no capture for this input. Retry submission keeps its original text and IDs; New request keeps this original saved for later inspection.";
    case "captured":
      return "Original source captured. Retry submission continues Jev admission with the same identity.";
    case "processing":
      return result.recovery === "required"
        ? "Admission was interrupted. Resume asks Jev to continue under a new recovery generation."
        : `Jev admission is ${result.stage}. Inspect to read its current state.`;
    case "work":
      return "Jev admitted this exact source to the work ledger. Native execution and verification are reported separately below.";
    case "turn":
      return `Jev routed this exact source to ${result.route}. Hosted conversation delivery is reported separately below.`;
    case "blocked":
      return result.reason === "unsupported-source"
        ? "Admission is blocked by an unsupported source. Submit a new complete request when that source is available."
        : "Admission is blocked by missing context. Submit a new complete request with the context included.";
    case "refused":
      return result.reason === "exhausted"
        ? "Jev admission refused this source after the bounded proposal attempts."
        : "Jev refused admission of this source.";
    case "cancelled":
      return "Intake was cancelled before work admission.";
  }
}

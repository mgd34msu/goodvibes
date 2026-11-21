/**
 * session-handover.ts, moving a session that one terminal has open to another
 * terminal, with one writer at every moment (`/session resume <id> --force`).
 *
 * A session is written by the one terminal that holds its lock (a kernel lock
 * the session store takes at open; a terminal that exits drops it). The
 * terminal that wants the session does not take it: it asks the holder to let
 * go, through the daemon both are attached to. The request is a steer on that
 * session marked `sessionHandover`; the holder's inbound poller collects it,
 * saves the session, releases its lock, tells its person the session moved,
 * and reports the input done. The asking terminal waits for that report on the
 * daemon's session-update stream and only then opens the session, which takes
 * the lock itself.
 *
 * Two terminals that are not both attached to one daemon have no channel
 * between them: the asking terminal cannot reach the holder, and says so.
 */
import { RefusalError, refusal } from '@goodvibes/engine/errors';
import type { SessionManager, SessionMeta } from '@goodvibes/engine/platform/platform/sessions';
import type { DaemonVerbCaller } from '@goodvibes/engine/platform/platform/runtime/client';
import { closeSessionHere, type SessionIdentitySurface } from '@goodvibes/engine/platform/platform/runtime/operations';

/** The input metadata key that marks a steer as a request to let go of the session. */
export const SESSION_HANDOVER_METADATA_KEY = 'sessionHandover';

/** The surface id a handover request is sent under (never a terminal's own, so the holder never skips it). */
const HANDOVER_SURFACE_ID = 'surface:session-handover';

function notHandedOver(sessionId: string, reason: string, next: readonly string[]): RefusalError {
  return new RefusalError(refusal({
    code: 'SESSION_OPEN_ELSEWHERE',
    state: `session ${sessionId} was not resumed here; the terminal that has it open keeps it`,
    reason,
    next: [...next],
  }));
}

interface InputRow { readonly id?: unknown; readonly state?: unknown }

function readInputs(payload: unknown): readonly InputRow[] {
  if (Array.isArray(payload)) return payload as InputRow[];
  const inputs = (payload as { inputs?: unknown } | null)?.inputs;
  return Array.isArray(inputs) ? inputs as InputRow[] : [];
}

/**
 * Ask the terminal that has `sessionId` open to let go of it, and resolve once
 * it has (its lock is released). Refused, with what to do, when no daemon
 * connects the two terminals, when the holder is not attached to it, or when
 * the holder could not let go. Costs one steer and one read per session update
 * while it waits.
 */
export async function requestSessionHandover(deps: {
  readonly sessionId: string;
  readonly verbs: DaemonVerbCaller;
  /** The daemon's session-update stream: `onChange(sessionId)` when a session's inputs moved; `onEnd` when the stream stops. */
  readonly subscribeInputChanges: (onChange: (sessionId: string) => void, handlers?: { readonly onEnd?: () => void }) => () => void;
}): Promise<void> {
  const { sessionId, verbs } = deps;
  const reach = verbs.probe();
  if (!reach.available) {
    throw notHandedOver(sessionId,
      `It is open in another terminal, and this terminal is not attached to a daemon (${reach.reason}). Two terminals reach each other only through the daemon they are both attached to, so the other one cannot be asked to let go.`,
      ['Close the session in the other terminal, or switch that terminal to another session, then resume it here']);
  }
  const answer = await verbs.invoke<{ readonly mode?: unknown; readonly input?: { readonly id?: unknown } }>('sessions.steer', {
    sessionId,
    body: 'Hand this session over to the terminal that asked for it.',
    surfaceId: HANDOVER_SURFACE_ID,
    metadata: { [SESSION_HANDOVER_METADATA_KEY]: true },
  });
  const inputId = typeof answer?.input?.id === 'string' ? answer.input.id : '';
  if (answer?.mode !== 'queued-for-surface' || !inputId) {
    if (inputId) await verbs.invoke('sessions.inputs.cancel', { sessionId, inputId }).catch(() => undefined);
    throw notHandedOver(sessionId,
      'It is open in another terminal that is not attached to this daemon, so it cannot be asked to let go.',
      ['Close the session in the other terminal, or switch that terminal to another session, then resume it here']);
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      if (error) reject(error); else resolve();
    };
    const check = async (): Promise<void> => {
      let state: unknown;
      try {
        const rows = readInputs(await verbs.invoke('sessions.inputs.list', { sessionId, limit: 200 }));
        state = rows.find((row) => row.id === inputId)?.state;
      } catch {
        return; // read again on the next update
      }
      if (state === 'completed') finish();
      else if (state === 'failed' || state === 'cancelled') {
        finish(notHandedOver(sessionId, 'The terminal that has it open did not let go of it.', ['Close the session there, then resume it here']));
      }
    };
    unsubscribe = deps.subscribeInputChanges((changed) => { if (changed === sessionId) void check(); }, {
      onEnd: () => {
        void verbs.invoke('sessions.inputs.cancel', { sessionId, inputId }).catch(() => undefined);
        finish(notHandedOver(sessionId, 'The daemon\'s session updates stopped before the other terminal let go, so the request was withdrawn.',
          ['Resume it again when the daemon answers, or close the session in the other terminal first']));
      },
    });
    // An answer that came before the subscription opened is read once now.
    void check();
  });
}

/** The live conversation a holder saves before it lets go. */
export interface HandoverConversation {
  readonly title: string;
  toJSON(): unknown;
  getTitleSource(): SessionMeta['titleSource'];
  branchState(): Parameters<SessionManager['save']>[5];
}

/**
 * The holder's half: save the session, release its lock (the store's and the
 * open-session marker), and tell the person. Afterwards this terminal does not
 * write the session: its next save is refused by the store, which the other
 * terminal now holds. Returns false when this terminal is not on `sessionId`.
 */
export function handOverLiveSession(deps: {
  readonly sessionId: string;
  readonly liveSessionId: () => string;
  readonly conversation: HandoverConversation;
  readonly sessionManager: Pick<SessionManager, 'save' | 'closeForWriting'>;
  readonly runtime: { readonly model: string; readonly provider: string };
  readonly surface?: SessionIdentitySurface | undefined;
  readonly notify: (text: string) => void;
}): boolean {
  const { sessionId } = deps;
  if (deps.liveSessionId() !== sessionId) return false;
  let saved = true;
  try {
    const messages = (deps.conversation.toJSON() as { messages?: unknown[] }).messages ?? [];
    deps.sessionManager.save(sessionId, messages as Parameters<SessionManager['save']>[1], {
      title: deps.conversation.title,
      model: deps.runtime.model,
      provider: deps.runtime.provider,
      timestamp: Date.now(),
      titleSource: deps.conversation.getTitleSource(),
      saveSource: 'auto',
    }, undefined, undefined, deps.conversation.branchState());
  } catch {
    saved = false;
  }
  deps.sessionManager.closeForWriting();
  if (deps.surface) closeSessionHere(deps.surface, sessionId);
  deps.notify(`Session ${sessionId} moved to another terminal that asked for it (/session resume ${sessionId} --force). `
    + (saved ? 'It was saved first. ' : 'Its last save stands; the newest turn here may not be in it. ')
    + 'This terminal no longer writes it: start a new session or resume another to keep working here.');
  return true;
}

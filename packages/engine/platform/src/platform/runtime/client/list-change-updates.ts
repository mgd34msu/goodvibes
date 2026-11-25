/**
 * list-change-updates.ts, how a terminal screen hears that the daemon changed a list it shows.
 *
 * The daemon publishes `LIST_CHANGED` (`{ list, change, id? }`) on the `workspace`
 * domain after the write that changed the list (runtime/list-changes.ts). A screen
 * that shows one of those lists opens the daemon's event stream narrowed to that
 * domain while it is open, and reads the list again on each notice for it.
 *
 * A stream that cannot be opened or ends quietly stops: the screen still reads the
 * list when it opens. Nothing here retries or waits on a clock.
 */
import { resolve } from 'node:path';
import { openRawServerSentEventStream } from '../transports/sse-stream.js';
import { buildUrl } from '../transports/transport-paths.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** The wire event and domain `LIST_CHANGED` travels on. */
export const LIST_CHANGE_WIRE_EVENT = 'workspace';
export const LIST_CHANGE_DOMAIN = 'workspace';

export interface ListChangeSubscriberOptions {
  readonly baseUrl: string | (() => string);
  readonly getAuthToken?: (() => string | null | Promise<string | null>) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * The folder this screen's program works in: a LIST_CHANGED about another project's list (one that names its
   * project) is not a change for this screen. Absent: every notice counts.
   */
  readonly workingDirectory?: string | undefined;
}

/** Whether a notice that names a project is about another project than the screen's (so the screen ignores it). */
function aboutAnotherProject(record: { readonly project?: string | undefined } | undefined, workingDirectory: string | undefined): boolean {
  return record?.project !== undefined && workingDirectory !== undefined && resolve(workingDirectory) !== record.project;
}

/** The `list` a frame's LIST_CHANGED names (the envelope or its payload), or undefined for any other frame. */
export function listChangeOf(frame: unknown): string | undefined {
  return listChangeRecordOf(frame)?.list;
}

/** A frame's runtime event type (`LIST_CHANGED`, `NATIVE_REQUEST_CHANGED`: the envelope's or its payload's), if it has one. */
export function eventTypeOf(frame: unknown): string | undefined {
  const outer = (typeof frame === 'object' && frame !== null ? frame : {}) as { type?: unknown; payload?: unknown };
  const inner = (typeof outer.payload === 'object' && outer.payload !== null ? outer.payload : {}) as { type?: unknown };
  return typeof inner.type === 'string' ? inner.type : typeof outer.type === 'string' ? outer.type : undefined;
}

/** The list a frame's LIST_CHANGED names and the record it names (`id`: for `capabilities`, the capability that ran). */
export function listChangeRecordOf(frame: unknown): { readonly list: string; readonly id?: string | undefined; readonly project?: string | undefined; readonly sessionId?: string | undefined } | undefined {
  const outer = (typeof frame === 'object' && frame !== null ? frame : {}) as { type?: unknown; list?: unknown; id?: unknown; project?: unknown; sessionId?: unknown; payload?: unknown };
  const inner = (typeof outer.payload === 'object' && outer.payload !== null ? outer.payload : {}) as { type?: unknown; list?: unknown; id?: unknown; project?: unknown; sessionId?: unknown };
  for (const event of [inner, outer]) {
    if (event.type === 'LIST_CHANGED' && typeof event.list === 'string') {
      return {
        list: event.list, ...(typeof event.id === 'string' ? { id: event.id } : {}),
        ...(typeof event.project === 'string' ? { project: event.project } : {}),
        ...(typeof event.sessionId === 'string' ? { sessionId: event.sessionId } : {}),
      };
    }
  }
  return undefined;
}

/** What a screen follows on the daemon's event stream: whole domains, named wire events, LIST_CHANGED lists. */
export interface DaemonFrameInterest {
  /** Domains to open the stream on (`automation`, `gate`, `workspace` for LIST_CHANGED). */
  readonly domains: readonly string[];
  /** Wire event names that count as a change (a domain's frames carry its name; `approval-update`, `owner-inbox-update`). */
  readonly events: readonly string[];
  /** LIST_CHANGED lists that count as a change. */
  readonly lists?: readonly string[] | undefined;
}

/** The frame that counted: its wire event, and the LIST_CHANGED list it names when it is one. */
export interface DaemonFrameChange {
  readonly event: string;
  readonly list?: string | undefined;
  /** The runtime event's own type, when the frame carries one (`NATIVE_REQUEST_CHANGED`). */
  readonly type?: string | undefined;
  /** The record the LIST_CHANGED names: for `capabilities`, the id of the capability that ran. */
  readonly id?: string | undefined;
}

/** How a followed stream stands, for a screen that says why its list may be old. */
export type DaemonFrameStreamState =
  | { readonly kind: 'open' }
  | { readonly kind: 'lost'; readonly reason: string };

/**
 * Follow the daemon's event stream for what `interest` names: `onChange` is
 * called for each frame that counts, with that frame (so a screen of several
 * lists reads only those that follow it), and once with nothing each time the
 * stream opens again after it was lost (frames may have been missed in
 * between, so the screen reads every list again). `onState` hears the stream
 * open and get lost.
 * A stream that cannot be opened at all reports that once and stops; the
 * screen still reads its list when it opens. Nothing here waits on a clock:
 * reconnecting is the transport's own.
 */
export function subscribeDaemonEventFrames(
  options: ListChangeSubscriberOptions,
  interest: DaemonFrameInterest,
  onChange: (change?: DaemonFrameChange) => void,
  onState?: ((state: DaemonFrameStreamState) => void) | undefined,
): () => void {
  let closed = false;
  let close: (() => void) | null = null;
  let lost = false;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return () => { closed = true; };
  const events = new Set(interest.events);
  const lists = new Set(interest.lists ?? []);
  const changed = (change?: DaemonFrameChange): void => {
    if (closed) return;
    try { onChange(change); } catch (error) { logger.debug('[daemon frames] a subscriber threw', { error: summarizeError(error) }); }
  };
  const state = (next: DaemonFrameStreamState): void => {
    if (closed) return;
    try { onState?.(next); } catch (error) { logger.debug('[daemon frames] a state listener threw', { error: summarizeError(error) }); }
  };
  void (async () => {
    try {
      const baseUrl = typeof options.baseUrl === 'function' ? options.baseUrl() : options.baseUrl;
      const url = new URL(buildUrl(baseUrl, '/api/control-plane/events'));
      url.searchParams.set('domains', [...new Set(interest.domains)].join(','));
      const opened = await openRawServerSentEventStream(
        fetchImpl,
        url.toString(),
        {
          onEvent: ({ name: eventName, payload }) => {
            if (closed) return;
            // One call per frame, naming it: a LIST_CHANGED for a followed list, or a followed wire event.
            const record = eventName === LIST_CHANGE_WIRE_EVENT ? listChangeRecordOf(payload) : undefined;
            // Another project's list changed: nothing this screen shows.
            if (aboutAnotherProject(record, options.workingDirectory)) return;
            const list = record?.list;
            // A runtime event's own type ("NATIVE_REQUEST_CHANGED") counts too, so a screen can name one event of a busy domain.
            const type = eventTypeOf(payload);
            if (events.has(eventName) || (type !== undefined && events.has(type)) || (list !== undefined && lists.has(list))) {
              changed({ event: eventName, ...(type !== undefined ? { type } : {}), ...(list !== undefined ? { list } : {}), ...(record?.id !== undefined ? { id: record.id } : {}) });
            }
          },
          onReady: () => {
            state({ kind: 'open' });
            if (lost) { lost = false; changed(); }
          },
          onReconnect: ({ error }) => {
            lost = true;
            state({ kind: 'lost', reason: summarizeError(error) });
          },
          onGap: () => { lost = true; },
          onEnd: (end) => {
            state({ kind: 'lost', reason: end.kind === 'failed' ? end.refusal.reason : 'the daemon closed its event stream' });
          },
        },
        // The transport's own reconnect (as the power chip's stream): a lost stream comes back by itself.
        { reconnect: { enabled: true }, ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}) },
      );
      if (closed) { opened(); return; }
      close = opened;
    } catch (error) {
      state({ kind: 'lost', reason: summarizeError(error) });
      logger.debug('[daemon frames] the daemon event stream could not be opened; the screen reads its list when it opens', { error: summarizeError(error) });
    }
  })();
  return () => {
    closed = true;
    close?.();
    close = null;
  };
}

/**
 * Follow the daemon's LIST_CHANGED notices for `lists`; `onChange` is called with the list's
 * name for each. Returns the unsubscribe (which also closes the stream).
 */
export function subscribeDaemonListChanges(
  options: ListChangeSubscriberOptions,
  lists: readonly string[],
  onChange: (list: string) => void,
): () => void {
  let closed = false;
  let close: (() => void) | null = null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return () => { closed = true; };
  const wanted = new Set(lists);
  void (async () => {
    try {
      const baseUrl = typeof options.baseUrl === 'function' ? options.baseUrl() : options.baseUrl;
      const url = new URL(buildUrl(baseUrl, '/api/control-plane/events'));
      url.searchParams.set('domains', LIST_CHANGE_DOMAIN);
      const opened = await openRawServerSentEventStream(
        fetchImpl,
        url.toString(),
        {
          onEvent: ({ name: eventName, payload }) => {
            if (closed || eventName !== LIST_CHANGE_WIRE_EVENT) return;
            const record = listChangeRecordOf(payload);
            if (aboutAnotherProject(record, options.workingDirectory)) return;
            const list = record?.list;
            if (list === undefined || !wanted.has(list)) return;
            try {
              onChange(list);
            } catch (error) {
              logger.debug('[list changes] a subscriber threw', { error: summarizeError(error) });
            }
          },
          onGap: () => { close?.(); close = null; },
          onEnd: () => {},
        },
        options.getAuthToken ? { getAuthToken: options.getAuthToken } : {},
      );
      if (closed) { opened(); return; }
      close = opened;
    } catch (error) {
      logger.debug('[list changes] the daemon event stream could not be opened; the screen reads its list when it opens', { error: summarizeError(error) });
    }
  })();
  return () => {
    closed = true;
    close?.();
    close = null;
  };
}

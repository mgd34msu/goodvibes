/**
 * daemon-power-source.ts, the adopted daemon's power state for a terminal
 * surface's always-visible keep-awake chip. The one source both terminal
 * products use; each maps the state to its own chip text.
 *
 * With a daemon adopted, the daemon owns keep-awake (its hold outlives the
 * surface), so the chip renders the daemon's `power.status.get`. The daemon
 * publishes `OPS_POWER_STATE_CHANGED` on the `ops` event domain whenever sleep
 * ownership changes, so while that stream is open the state is read once per
 * change (and once per connect), plus a slow safety read. Only while no stream
 * is open (it could not be opened, it ended, or the credential may not read
 * `ops`) does the source poll at the short cadence. A surface also calls
 * `refresh()` when it changes keep-awake itself or a turn ends.
 *
 * Cost per open surface: with the stream open, one held connection and one
 * read per power change, plus one read a minute; without it, one read every
 * five seconds while a daemon is adopted. Nothing while none is.
 */
import { openRawServerSentEventStream } from '../runtime/transports/sse-stream.js';
import { buildUrl } from '../runtime/transports/transport-paths.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { PowerState } from './manager.js';

/** The event domain the daemon publishes power changes on. */
export const POWER_EVENT_DOMAIN = 'ops';
/** The runtime event that says sleep ownership changed. */
export const POWER_STATE_CHANGED_EVENT = 'OPS_POWER_STATE_CHANGED';

/** A live power-event subscription. `close()` is idempotent. */
export interface DaemonPowerEventWatch {
  close(): void;
}

export interface DaemonPowerEventHandlers {
  /** The stream is open and delivers power events (called on each connect, reconnects included). */
  readonly onLive: () => void;
  /** Sleep ownership changed on the daemon. */
  readonly onChange: () => void;
  /**
   * The stream ended and will not deliver more. `retry` is false when opening
   * it again cannot help (this credential may not read the `ops` domain). Not
   * called for `close()`.
   */
  readonly onEnded: (retry: boolean) => void;
}

export interface WatchDaemonPowerEventsOptions extends DaemonPowerEventHandlers {
  /** The daemon's base URL, e.g. `http://127.0.0.1:3421`. */
  readonly baseUrl: string;
  /** Bearer token for the control plane, resolved per connection attempt. */
  readonly getAuthToken?: (() => string | null | Promise<string | null>) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Open the daemon's `ops` event stream for power changes; null when it could not be opened. */
export async function watchDaemonPowerEvents(options: WatchDaemonPowerEventsOptions): Promise<DaemonPowerEventWatch | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return null;
  const url = new URL(buildUrl(options.baseUrl, '/api/control-plane/events'));
  url.searchParams.set('domains', POWER_EVENT_DOMAIN);
  let closed = false;
  let closeStream: (() => void) | null = null;
  const end = (retry: boolean): void => {
    if (closed) return;
    closed = true;
    closeStream?.();
    options.onEnded(retry);
  };
  try {
    const handle = await openRawServerSentEventStream(fetchImpl, url.toString(), {
      onReady: (payload) => {
        if (closed) return;
        const domains = isRecord(payload) && Array.isArray(payload.domains) ? payload.domains : [];
        // A credential that may not read `ops` gets a stream that will never carry a power change.
        if (domains.includes(POWER_EVENT_DOMAIN)) options.onLive();
        else end(false);
      },
      onEvent: (eventName, payload) => {
        if (closed || eventName !== POWER_EVENT_DOMAIN) return;
        if (isRecord(payload) && payload.type === POWER_STATE_CHANGED_EVENT) options.onChange();
      },
      onTerminate: ({ final }) => end(final !== true),
      onClose: () => end(true),
    }, {
      ...(options.getAuthToken ? { getAuthToken: options.getAuthToken } : {}),
      reconnect: { enabled: true },
    });
    closeStream = () => handle();
    if (closed) handle();
    return {
      close: (): void => {
        if (closed) return;
        closed = true;
        handle();
      },
    };
  } catch (error) {
    logger.debug('[power] the power event stream could not be opened; the keep-awake chip reads the daemon on a short poll', {
      error: summarizeError(error),
    });
    return null;
  }
}

export interface DaemonPowerStateSourceDeps {
  /** Whether a daemon is adopted right now; nothing is read while none is. */
  readonly isAdopted: () => boolean;
  /** The daemon's `power.status.get`; null when it cannot be read. */
  readonly fetchDaemon: () => Promise<PowerState | null>;
  /** Open the daemon's power event stream (usually {@link watchDaemonPowerEvents}); without it the source polls. */
  readonly watchEvents?: ((handlers: DaemonPowerEventHandlers) => Promise<DaemonPowerEventWatch | null>) | undefined;
  /** Called when the daemon's state, as this source holds it, changed. */
  readonly onChange: () => void;
  /** Read cadence while no event stream is open (default 5000 ms). */
  readonly pollIntervalMs?: number | undefined;
  /** Safety read cadence while the event stream is open (default 60000 ms). */
  readonly livePollIntervalMs?: number | undefined;
  /** Wait before opening the stream again after it failed or ended (default 60000 ms). */
  readonly watchRetryMs?: number | undefined;
  readonly timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } | undefined;
  readonly now?: (() => number) | undefined;
}

export interface DaemonPowerStateSource {
  /** The adopted daemon's state; undefined while none is adopted or no answer is in hand. */
  current(): PowerState | undefined;
  /** Read the daemon now: keep-awake was changed here, or a turn ended. */
  refresh(): void;
  stop(): void;
}

export function createDaemonPowerStateSource(deps: DaemonPowerStateSourceDeps): DaemonPowerStateSource {
  const timers = deps.timers ?? { setInterval, clearInterval };
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollIntervalMs ?? 5000;
  const livePollMs = deps.livePollIntervalMs ?? 60_000;
  const watchRetryMs = deps.watchRetryMs ?? 60_000;
  let state: PowerState | undefined;
  let held = 'undefined';
  let stopped = false;
  let reading = false;
  let readAgain = false;
  let lastReadAt = 0;
  let watch: DaemonPowerEventWatch | null = null;
  let watchAttempt = 0;
  let opening = false;
  let live = false;
  let watchAllowed = deps.watchEvents !== undefined;
  let nextWatchAt = 0;

  const settle = (next: PowerState | undefined): void => {
    const text = next === undefined ? 'undefined' : JSON.stringify(next);
    state = next;
    if (text === held) return;
    held = text;
    deps.onChange();
  };

  const read = async (): Promise<void> => {
    if (stopped) return;
    if (reading) { readAgain = true; return; }
    reading = true;
    try {
      do {
        readAgain = false;
        lastReadAt = now();
        const next = await deps.fetchDaemon().catch(() => null);
        if (stopped) return;
        settle(deps.isAdopted() && next ? next : undefined);
      } while (readAgain && !stopped);
    } finally {
      reading = false;
    }
  };

  const closeWatch = (): void => {
    watchAttempt += 1;
    live = false;
    opening = false;
    const current = watch;
    watch = null;
    current?.close();
  };

  const openWatch = (): void => {
    if (!watchAllowed || watch || opening || now() < nextWatchAt || !deps.watchEvents) return;
    opening = true;
    const attempt = ++watchAttempt;
    const isCurrent = (): boolean => attempt === watchAttempt && !stopped;
    let ended = false;
    void deps.watchEvents({
      onLive: () => {
        if (!isCurrent() || ended) return;
        live = true;
        // A connect may follow changes this source did not hear about.
        void read();
      },
      onChange: () => { if (isCurrent() && !ended) void read(); },
      onEnded: (retry) => {
        if (!isCurrent() || ended) return;
        ended = true;
        watch = null;
        opening = false;
        live = false;
        if (retry) nextWatchAt = now() + watchRetryMs;
        else watchAllowed = false;
      },
    }).then((opened) => {
      if (!isCurrent()) { opened?.close(); return; }
      opening = false;
      if (!opened) { nextWatchAt = now() + watchRetryMs; return; }
      // Ended while it was opening (onEnded already cleared it), or the daemon was let go meanwhile.
      if (ended || !deps.isAdopted()) { opened.close(); live = false; return; }
      watch = opened;
    }, () => {
      if (!isCurrent()) return;
      opening = false;
      nextWatchAt = now() + watchRetryMs;
    });
  };

  const tick = (): void => {
    if (stopped) return;
    if (!deps.isAdopted()) {
      if (watch || opening) closeWatch();
      settle(undefined);
      return;
    }
    openWatch();
    if (!live || now() - lastReadAt >= livePollMs) void read();
  };

  const interval = timers.setInterval(tick, pollMs);
  (interval as { unref?: () => void }).unref?.();
  tick();

  return {
    current: () => (deps.isAdopted() ? state : undefined),
    refresh: () => { if (!stopped && deps.isAdopted()) void read(); },
    stop: () => {
      stopped = true;
      timers.clearInterval(interval);
      closeWatch();
    },
  };
}

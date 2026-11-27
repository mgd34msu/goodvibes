/**
 * daemon-attach-notices, what this terminal reads from the daemon it adopts.
 *
 * On attach the terminal reads the daemon's undelivered receipts
 * (update/crash/migration) over `/status` (peek, then acknowledge what was
 * parsed, readExternalDaemonAttach) and renders each as a one-line notice; the
 * sandbox first-contained-run line comes through the shared announcement
 * store (createSandboxContainmentNotice).
 */
import { FeatureAnnouncementStore, featureAnnouncementsPath, createSandboxContainmentAnnouncer } from '@goodvibes/engine/platform/platform/runtime/feature-announcements';
import { readClientCompatibilityFloor } from '@goodvibes/engine/platform/platform/control-plane/build-compatibility';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { firstShowingOfSettingsNotice } from '@goodvibes/engine/terminal-shell/cli-config-overrides';
import { programCallHeadersFor } from '@goodvibes/engine/platform/platform/runtime/client';

/** A daemon receipt line (already a human one-liner, e.g. "restarted after a crash at 2026-11-15 14:32"). */
export interface DaemonReceiptLike {
  readonly id: string;
  readonly text: string;
  readonly at: number;
}

/** Milliseconds an external-daemon `/status` read waits before giving up. */
const EXTERNAL_RECEIPTS_TIMEOUT_MS = 1500;

export interface ExternalDaemonAttachReadDeps {
  /** The adopted daemon's base URL, e.g. "http://127.0.0.1:3421". */
  readonly baseUrl: string;
  /** The shared bearer the adopted daemon authenticates (the companion-pairing token). */
  readonly authToken: string;
  /**
   * Ask for the daemon's undelivered receipts on this read (peek, then
   * acknowledge what was parsed). Only the read that RENDERS them asks; a
   * reconnect read that just refreshes the two build floors leaves this off.
   */
  readonly consumeReceipts?: boolean;
  /** Injectable fetch for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable timeout (ms); defaults to EXTERNAL_RECEIPTS_TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

/** Everything one `/status` read of an adopted daemon tells this terminal. */
export interface ExternalDaemonAttachRead {
  /** True only when the daemon answered with a usable 2xx body. */
  readonly answered: boolean;
  /** Receipt lines to render; empty unless `consumeReceipts` was asked for. */
  readonly notices: string[];
  /**
   * The minimum CLIENT build the daemon announced on the
   * `X-Goodvibes-Client-Floor` response header, or undefined when it announced
   * none (a daemon too old to publish one is not asking for anything).
   */
  readonly clientFloor: string | undefined;
  /** The parsed body, which carries the daemon's own `version`. */
  readonly statusPayload: unknown;
}

// Ids per acknowledge request; the daemon accepts at most 200 per call.
const RECEIPT_ACK_BATCH = 100;

/**
 * One `/status` read of a separately-hosted (external/systemd) daemon, carrying
 * the three things attaching to it decides on: its undelivered receipts, the
 * client build floor it publishes, and its own build.
 *
 * The default deployment adopts such a daemon with no in-process handle,
 * so the embedded in-process fold sees nothing; this
 * hits the daemon's own endpoint instead, GET <baseUrl>/status with the shared
 * bearer, plus `?receipts=peek` when the caller is going to render them, then
 * `?receipts=ack` for the ids it parsed. The daemon marks only acknowledged
 * receipts delivered, so a lost response is offered again and a second attach
 * with nothing new returns no notices.
 * Any transport, auth, or parse failure reads as unanswered rather than
 * throwing into the attach path.
 */
export async function readExternalDaemonAttach(
  deps: ExternalDaemonAttachReadDeps,
): Promise<ExternalDaemonAttachRead> {
  const unanswered: ExternalDaemonAttachRead = {
    answered: false, notices: [], clientFloor: undefined, statusPayload: null,
  };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? EXTERNAL_RECEIPTS_TIMEOUT_MS);
  try {
    // With this program's registration: an owner alert kept as a receipt goes to the owner's own programs only, and the
    // shared bearer alone is a script on this machine.
    const headers = new Headers(await programCallHeadersFor(deps.baseUrl, deps.authToken.trim() || undefined, fetchImpl, 'tui'));
    if (deps.authToken.trim()) headers.set('Authorization', `Bearer ${deps.authToken.trim()}`);
    const statusUrl = `${deps.baseUrl.replace(/\/+$/, '')}/status`;
    const response = await fetchImpl(deps.consumeReceipts ? `${statusUrl}?receipts=peek` : statusUrl, { headers, signal: controller.signal });
    if (!response.ok) return unanswered;
    const body = (await response.json()) as { receipts?: unknown } | null;
    const receipts = Array.isArray(body?.receipts) ? body.receipts : [];
    const notices: string[] = [];
    for (const entry of receipts) {
      if (entry && typeof (entry as { text?: unknown }).text === 'string') {
        const text = (entry as { text: string }).text;
        // A settings notice this app already showed for the same file and key (one formatter writes both) is said once.
        if (text.trim().length > 0 && firstShowingOfSettingsNotice(text)) notices.push(text);
      }
    }
    // Acknowledge only what was parsed, so a response lost in transit leaves
    // the receipts with the daemon for the next attach.
    const ids = receipts
      .map((entry) => (entry as { id?: unknown } | null)?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    for (let index = 0; deps.consumeReceipts && index < ids.length; index += RECEIPT_ACK_BATCH) {
      const batch = ids.slice(index, index + RECEIPT_ACK_BATCH).map(encodeURIComponent).join(',');
      try {
        await fetchImpl(`${statusUrl}?receipts=ack&ids=${batch}`, { headers, signal: controller.signal });
      } catch {
        break;
      }
    }
    return {
      answered: true,
      notices,
      clientFloor: readClientCompatibilityFloor(response.headers),
      statusPayload: body,
    };
  } catch {
    return unanswered;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The "commands now run contained" first-run announcer for the sandboxed exec
 * path. Returns the callback registerAllTools calls on each contained run: the
 * FIRST call records the announce-once line (so any later attach-time consume
 * also sees it) and surfaces it now via `notify`; every later run is silent.
 */
export function createSandboxContainmentNotice(deps: {
  readonly configManager: Pick<ConfigManager, 'getControlPlaneConfigDir'>;
  readonly notify: (text: string) => void;
}): () => void {
  const store = new FeatureAnnouncementStore(featureAnnouncementsPath(deps.configManager));
  return createSandboxContainmentAnnouncer(store, (announcement) => deps.notify(announcement.text));
}

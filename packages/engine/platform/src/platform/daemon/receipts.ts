/**
 * Daemon receipts: one-line, human-readable records of daemon-side events
 * that happened while no surface was watching ("updated from X to Y at
 * 2026-11-15 03:12", "restarted after a crash at ...").
 *
 * Each receipt is written to the daemon log the moment it is recorded, and
 * persisted until a surface shows it: a /status read with `?receipts=peek`
 * receives the undelivered receipts without marking them, and the reader
 * names the ones it put on screen with `?receipts=ack`. A response lost in
 * transit leaves them with the daemon for the next reader. An owner alert no
 * channel took is kept for the owner alone (`audience: 'owner'`): only an
 * owner-class reader sees it or marks it delivered. A plain /status
 * read (identity probe, keepalive, version poll) neither receives nor marks
 * receipts.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import { isRecord } from '../utils/record-coerce.js';
import { readConsumerSetting, type ConsumerConfigReader } from '../config/profile-fallback.js';

/**
 * Who a receipt is for. `owner`: an owner alert no channel took, shown to and
 * taken by an owner-class reader only. `everyone`: any authenticated reader.
 * A receipt saved without the field (every file 3.3.4 wrote) is `everyone`.
 */
export type DaemonReceiptAudience = 'owner' | 'everyone';

export interface DaemonReceipt {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly deliveredAt?: number | undefined;
  /** Absent means `everyone`. */
  readonly audience?: 'owner' | undefined;
}

export interface ReceiptStoreIo {
  read(path: string): string | null;
  write(path: string, contents: string): void;
  /** Sets an unreadable file aside (returning where it went) so the next write cannot erase it. */
  quarantine?(path: string): string | null;
}

export const realReceiptStoreIo: ReceiptStoreIo = {
  read: (path) => (existsSync(path) ? readFileSync(path, 'utf-8') : null),
  write: (path, contents) => writeFileAtomic(path, contents),
  quarantine: (path) => {
    const aside = `${path}.unreadable-${Date.now()}`;
    try { renameSync(path, aside); return aside; } catch { return null; }
  },
};

const MAX_KEPT_RECEIPTS = 50;

/**
 * The age bound the count cap alone does not give. A receipt says "here is what
 * the daemon did while you were not looking"; a fortnight later nobody is going
 * to act on it, and on a quiet daemon the 50-slot cap would otherwise hold
 * month-old lines forever because nothing new ever pushed them out. Fourteen
 * days comfortably spans a holiday-length absence while still being a bound.
 */
const MAX_RECEIPT_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** What a load found on disk: the usable receipts plus what the file cost us. */
interface ParsedReceiptFile {
  readonly receipts: DaemonReceipt[];
  /** The file existed but was not parseable JSON, or was not a JSON array at all. */
  readonly unreadable: boolean;
  /** Entries present in a parseable file that were not well-formed receipts. */
  readonly droppedEntries: number;
}

function parseReceipts(raw: string | null): ParsedReceiptFile {
  if (raw === null) return { receipts: [], unreadable: false, droppedEntries: 0 };
  // An empty/whitespace-only file is the classic torn write: the file was
  // created (or truncated) and the process died before the content landed.
  if (!raw.trim()) return { receipts: [], unreadable: true, droppedEntries: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { receipts: [], unreadable: true, droppedEntries: 0 };
  }
  if (!Array.isArray(parsed)) return { receipts: [], unreadable: true, droppedEntries: 0 };
  const receipts = parsed.filter((entry): entry is DaemonReceipt =>
    isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.text === 'string'
    && typeof entry.at === 'number');
  return { receipts, unreadable: false, droppedEntries: parsed.length - receipts.length };
}

/**
 * The zone receipt times are stated in: the owner's `daemon.timezone` (or the
 * owner profile's zone when the setting is unset), else undefined, which
 * {@link formatReceiptTime} reads as this machine's own zone.
 */
export function receiptTimeZone(config: ConsumerConfigReader): string | undefined {
  const value = readConsumerSetting(config, 'daemon.timezone');
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** The zone this machine's clock shows. */
function machineTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Formats a timestamp as the date and wall-clock time for receipt text
 * ("2026-11-15 03:12"). A receipt can wait up to two weeks for a surface, so
 * the time of day alone would not say which day it was. The time is in
 * `timeZone` when given and known to the runtime, else in this machine's own
 * zone; the zone is named ("2026-11-15 03:12 Europe/Berlin") only when it is
 * not the machine's.
 */
export function formatReceiptTime(timestamp: number, timeZone?: string): string {
  const machine = machineTimeZone();
  let format: Intl.DateTimeFormat;
  let zone = timeZone ?? machine;
  try {
    format = receiptTimeFormat(zone);
  } catch {
    zone = machine;
    format = receiptTimeFormat(zone);
  }
  const named = format.resolvedOptions().timeZone === machine ? '' : ` ${zone}`;
  const parts = Object.fromEntries(format.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${named}`;
}

function receiptTimeFormat(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
}

/** Where a daemon keeps its receipts. */
export function daemonReceiptsPath(configManager: { getControlPlaneConfigDir(): string }): string {
  return join(configManager.getControlPlaneConfigDir(), 'control-plane', 'daemon-receipts.json');
}

const storesByPath = new Map<string, DaemonReceiptStore>();

/**
 * The one receipt store for a receipts file in this process. The lifecycle
 * runtime and the owner-alert fallback both record into it, so neither holds
 * a stale copy that would overwrite the other's lines.
 */
export function daemonReceiptStoreAt(path: string): DaemonReceiptStore {
  let store = storesByPath.get(path);
  if (!store) {
    store = new DaemonReceiptStore(path);
    storesByPath.set(path, store);
  }
  return store;
}

export class DaemonReceiptStore {
  private readonly io: ReceiptStoreIo;
  private readonly now: () => number;
  private receipts: DaemonReceipt[];

  constructor(
    private readonly path: string,
    options: { io?: ReceiptStoreIo; now?: () => number } = {},
  ) {
    this.io = options.io ?? realReceiptStoreIo;
    this.now = options.now ?? Date.now;

    // Recovery-time housekeeping, disclosed rather than silent. A crash can
    // leave this file torn, truncated or half-written; reading it as "no
    // receipts" and then overwriting it on the next record() would erase the
    // user's receipt history with nothing to show for it. Say what was lost.
    const loaded = parseReceipts(this.io.read(this.path));
    if (loaded.unreadable) {
      const keptAt = this.io.quarantine?.(this.path) ?? null;
      logger.warn('[daemon-receipt] receipt file was unreadable, starting from an empty receipt history', {
        path: this.path,
        ...(keptAt === null ? {} : { keptAt }),
      });
    } else if (loaded.droppedEntries > 0) {
      logger.warn('[daemon-receipt] discarded malformed receipt entries', {
        path: this.path,
        droppedEntries: loaded.droppedEntries,
        keptReceipts: loaded.receipts.length,
      });
    }

    const bounded = this.applyBounds(loaded.receipts);
    this.receipts = bounded.receipts;
    if (bounded.expired > 0) {
      logger.info('[daemon-receipt] retired receipts past their age bound', {
        path: this.path,
        expiredReceipts: bounded.expired,
        keptReceipts: this.receipts.length,
      });
      // Make the reap durable, but never let a read-only/unwritable store
      // break construction, the in-memory list is already correct.
      try {
        this.persist();
      } catch (error) {
        logger.warn('[daemon-receipt] could not persist the age-bound reap', {
          path: this.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Both bounds in one place: drop receipts older than MAX_RECEIPT_AGE_MS, then
   * keep at most MAX_KEPT_RECEIPTS (newest last, so the cap drops the oldest).
   * Idempotent, running it on an already-bounded list changes nothing.
   */
  private applyBounds(receipts: readonly DaemonReceipt[]): { receipts: DaemonReceipt[]; expired: number } {
    const cutoff = this.now() - MAX_RECEIPT_AGE_MS;
    const fresh = receipts.filter((receipt) => receipt.at >= cutoff);
    const expired = receipts.length - fresh.length;
    return { receipts: fresh.slice(-MAX_KEPT_RECEIPTS), expired };
  }

  /**
   * Record a receipt: logged immediately, persisted for the next surface.
   * `audience: 'owner'` keeps it for an owner-class reader only.
   */
  record(text: string, options: { readonly audience?: DaemonReceiptAudience | undefined } = {}): DaemonReceipt {
    const ownerOnly = options.audience === 'owner';
    // One event is often both recorded and raised as an owner alert, and an
    // alert no channel took is kept here too: the same line still waiting for
    // the next surface is that receipt, not a second one. Once the line is an
    // owner alert, the waiting receipt is kept for the owner alone, so no other
    // reader can take it before he sees it.
    const waiting = this.receipts.find((kept) => kept.deliveredAt === undefined && kept.text === text);
    if (waiting) {
      if (!ownerOnly || waiting.audience === 'owner') return waiting;
      const restricted: DaemonReceipt = { ...waiting, audience: 'owner' };
      this.receipts = this.receipts.map((kept) => (kept === waiting ? restricted : kept));
      this.persistOrLog();
      return restricted;
    }
    const receipt: DaemonReceipt = {
      id: `receipt-${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      at: this.now(),
      ...(ownerOnly ? { audience: 'owner' as const } : {}),
    };
    const bounded = this.applyBounds([...this.receipts, receipt]);
    this.receipts = bounded.receipts;
    if (bounded.expired > 0) {
      logger.info('[daemon-receipt] retired receipts past their age bound', {
        path: this.path,
        expiredReceipts: bounded.expired,
        keptReceipts: this.receipts.length,
      });
    }
    logger.info(`[daemon-receipt] ${text}`, { receiptId: receipt.id });
    this.persistOrLog();
    return receipt;
  }

  /** All receipts, newest last (delivered and undelivered). */
  list(): readonly DaemonReceipt[] {
    return this.receipts;
  }

  /**
   * Undelivered receipts the reader may see, left undelivered until
   * {@link markDelivered} names them. `owner`: the reader is owner-class;
   * owner-only receipts are left out for anyone else.
   */
  peekUndelivered(owner: boolean): readonly DaemonReceipt[] {
    return this.receipts.filter((receipt) => receipt.deliveredAt === undefined && (owner || receipt.audience !== 'owner'));
  }

  /**
   * Marks the named receipts delivered; ids that are unknown or already
   * delivered are ignored, and so is a non-owner's acknowledgement of an
   * owner-only receipt.
   */
  markDelivered(ids: ReadonlySet<string>, owner: boolean): void {
    const deliveredAt = this.now();
    let changed = false;
    this.receipts = this.receipts.map((receipt) => {
      if (receipt.deliveredAt !== undefined || !ids.has(receipt.id)) return receipt;
      if (!owner && receipt.audience === 'owner') return receipt;
      changed = true;
      return { ...receipt, deliveredAt };
    });
    if (changed) this.persistOrLog();
  }

  private persistOrLog(): void {
    try {
      this.persist();
    } catch (error) {
      logger.warn('[daemon-receipt] could not persist receipts', {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persist(): void {
    this.io.write(this.path, `${JSON.stringify(this.receipts, null, 2)}\n`);
  }
}

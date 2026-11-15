import { constants, closeSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { sendWebSocketMessage, WEBSOCKET_CHUNK_CHARS } from '@goodvibes-jev/engine/transport-core';

/** A client that stops reading must not grow the spill file without bound. */
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024;

/** One queued event that a connected client does not take within this long means it has stopped reading. */
const DEFAULT_STALL_TIMEOUT_MS = 2 * 60 * 1000;

const OUTBOX_DIRECTORY_PREFIX = 'goodvibes-ws-';
/** A spill directory this old belongs to no running process, whatever pid its name carries. */
const STALE_OUTBOX_AGE_MS = 24 * 60 * 60 * 1000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Remove spill directories a killed daemon left in the temp directory: they hold raw event
 * bodies. A directory is stale when the process named in it is gone, or when it is older than
 * any outbox could live. Several daemons may share the temp directory, so a live owner's
 * directory is left alone. Never throws; returns how many directories were removed.
 */
export function sweepStaleWebSocketOutboxes(
  directory: string = tmpdir(),
  options: { readonly now?: number; readonly isAlive?: (pid: number) => boolean } = {},
): number {
  const now = options.now ?? Date.now();
  const isAlive = options.isAlive ?? processIsAlive;
  let removed = 0;
  let names: string[];
  try { names = readdirSync(directory); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith(OUTBOX_DIRECTORY_PREFIX)) continue;
    const path = join(directory, name);
    try {
      const stat = lstatSync(path);
      if (!stat.isDirectory()) continue;
      const pid = Number(/^goodvibes-ws-(\d+)-/.exec(name)?.[1]);
      const ownerGone = Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && !isAlive(pid);
      if (!ownerGone && now - stat.mtimeMs <= STALE_OUTBOX_AGE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      logger.warn('Could not remove a stale WebSocket outbox directory', { directory: path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (removed > 0) logger.info('Removed stale WebSocket outbox directories left by a stopped daemon', { removed });
  return removed;
}

/** A slow socket spills queued events to a private file, without losing events or retaining their bodies in memory. */
export class WebSocketOutbox {
  private readonly lifetime = new AbortController();
  private directory: string | undefined;
  private fd: number | undefined;
  private offset = 0;
  private readonly records: { offset: number; length: number }[] = [];
  private running = false;
  private pendingBytes = 0;
  constructor(
    private readonly socket: { send(data: string): unknown; getBufferedAmount?(): number; close?(code: number, reason: string): void },
    private readonly maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
    /** Told how many frames were discarded undelivered, so ops output can show real loss. */
    private readonly onDropped?: (count: number) => void,
    private readonly stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
  ) {}
  send(text: string): void {
    if (this.lifetime.signal.aborted) { this.onDropped?.(1); return; }
    if (!this.running && text.length <= WEBSOCKET_CHUNK_CHARS && (this.socket.getBufferedAmount?.() ?? 0) <= 4 * 1024 * 1024) {
      this.socket.send(text); return;
    }
    const bytes = Buffer.from(text);
    if (this.pendingBytes + bytes.length > this.maxPendingBytes) {
      logger.warn('WebSocket client is not reading; closing it instead of queueing more events', { pendingBytes: this.pendingBytes });
      this.onDropped?.(this.records.length + 1);
      this.abandon(1013, 'WebSocket client is too slow');
      return;
    }
    try { this.enqueue(bytes); } catch (error) {
      logger.warn('WebSocket outbox write failed; closing the connection', { error: error instanceof Error ? error.message : String(error) });
      this.onDropped?.(this.records.length + 1);
      this.abandon(1011, 'WebSocket delivery failed');
      return;
    }
    if (!this.running) void this.drain();
  }
  private abandon(code: number, reason: string): void {
    this.lifetime.abort(); this.records.length = 0; this.pendingBytes = 0;
    if (!this.running) this.cleanup();
    this.socket.close?.(code, reason);
  }
  private enqueue(bytes: Buffer): void {
    if (this.fd === undefined) {
      this.directory = mkdtempSync(join(tmpdir(), `${OUTBOX_DIRECTORY_PREFIX}${process.pid}-`));
      this.fd = openSync(join(this.directory, 'outbox'), constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    }
    const offset = this.offset;
    let written = 0;
    while (written < bytes.length) written += writeSync(this.fd, bytes, written, bytes.length - written, offset + written);
    this.offset += bytes.length;
    this.records.push({ offset, length: bytes.length });
    this.pendingBytes += bytes.length;
  }
  private async drain(): Promise<void> {
    this.running = true;
    let stall: AbortSignal | undefined;
    try {
      while (this.records.length && !this.lifetime.signal.aborted) {
        const record = this.records.shift()!;
        this.pendingBytes -= record.length;
        const bytes = Buffer.alloc(record.length);
        let read = 0;
        while (read < bytes.length) {
          const n = readSync(this.fd!, bytes, read, bytes.length - read, record.offset + read);
          if (!n) throw new Error('Incomplete WebSocket outbox');
          read += n;
        }
        stall = AbortSignal.timeout(this.stallTimeoutMs);
        await sendWebSocketMessage(this.socket, bytes.toString('utf8'), AbortSignal.any([this.lifetime.signal, stall]));
      }
    } catch (error) {
      // An abort came from close() or the pending-bytes cap, which already closed the socket.
      if (!this.lifetime.signal.aborted && stall?.aborted) {
        logger.warn('WebSocket client stopped reading; closing it', { stallTimeoutMs: this.stallTimeoutMs, pendingBytes: this.pendingBytes });
        this.onDropped?.(this.records.length + 1);
        this.lifetime.abort(); this.records.length = 0; this.pendingBytes = 0; this.socket.close?.(1013, 'WebSocket client is too slow');
      } else if (!this.lifetime.signal.aborted) {
        logger.warn('WebSocket delivery failed; closing the connection', { error: error instanceof Error ? error.message : String(error) });
        // The record being sent was taken off the queue before it failed.
        this.onDropped?.(this.records.length + 1);
        this.lifetime.abort(); this.records.length = 0; this.pendingBytes = 0; this.socket.close?.(1011, 'WebSocket delivery failed');
      }
    }
    finally { this.running = false; this.cleanup(); }
  }
  close(): void {
    if (this.records.length > 0) this.onDropped?.(this.records.length);
    this.lifetime.abort(); this.records.length = 0; this.pendingBytes = 0; this.cleanup();
  }
  private cleanup(): void {
    if (this.fd !== undefined) { closeSync(this.fd); this.fd = undefined; }
    if (this.directory !== undefined) { rmSync(this.directory, { recursive: true, force: true }); this.directory = undefined; }
    this.offset = 0;
  }
}

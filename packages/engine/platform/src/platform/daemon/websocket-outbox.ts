import { constants, closeSync, lstatSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { encodeWebSocketMessage, sendWebSocketMessage } from '@goodvibes/engine/transport-core';

/** A client that stops reading must not grow the spill file without bound. */
const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024;

/**
 * Bytes written to one spill file before new records go to a fresh one. A
 * file is removed once its last record is sent, so a client that keeps up
 * slowly for a whole session holds at most the undelivered bytes plus one
 * file's worth on disk, not the size of the stream.
 */
const SPILL_FILE_BYTES = 8 * 1024 * 1024;

/** Bytes the socket may hold unsent before new messages spill; the same mark `sendWebSocketMessage` waits on. */
const SOCKET_HIGH_WATER_BYTES = 4 * 1024 * 1024;

interface SpillFile { readonly fd: number; readonly path: string; written: number; pending: number }

/** One queued event that a connected client does not take within this long means it has stopped reading. */
const DEFAULT_STALL_TIMEOUT_MS = 2 * 60 * 1000;

const OUTBOX_DIRECTORY_PREFIX = 'goodvibes-ws-';
/** A spill directory this old belongs to no running process, whatever pid its name carries. */
const STALE_OUTBOX_AGE_MS = 24 * 60 * 60 * 1000;

function* resumeFrames(next: string, rest: Iterable<string>): Generator<string> {
  yield next;
  yield* rest;
}

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

/**
 * A socket that is behind spills queued events to a private file, without losing events or retaining
 * their bodies in memory. A socket that keeps up never touches the file.
 */
export class WebSocketOutbox {
  private readonly lifetime = new AbortController();
  private directory: string | undefined;
  /** In write order; the last one takes new records. */
  private readonly files: SpillFile[] = [];
  private fileCount = 0;
  private readonly records: { file: SpillFile; offset: number; length: number }[] = [];
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
    // Only a socket that is behind spills; a ready one takes the message now, whatever its size.
    if (!this.running && (this.socket.getBufferedAmount?.() ?? 0) <= SOCKET_HIGH_WATER_BYTES) { this.sendNow(text); return; }
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
  /**
   * Writes a message's frames while the socket keeps up. If it falls behind mid-message, the
   * remaining frames go to the drain loop, which waits for the socket; later sends queue behind them.
   */
  private sendNow(text: string): void {
    const frames = encodeWebSocketMessage(text);
    try {
      for (let index = 0; ; index += 1) {
        const next = frames.next();
        if (next.done) return;
        if (index > 0 && (this.socket.getBufferedAmount?.() ?? 0) > SOCKET_HIGH_WATER_BYTES) {
          void this.drain(resumeFrames(next.value, frames));
          return;
        }
        // Bun returns 0 when it dropped the frame: the client would see a gap, so it reconnects instead.
        if (this.socket.send(next.value) === 0) throw new Error('WebSocket dropped an outgoing message');
      }
    } catch (error) {
      logger.warn('WebSocket delivery failed; closing the connection', { error: error instanceof Error ? error.message : String(error) });
      this.onDropped?.(1);
      this.abandon(1011, 'WebSocket delivery failed');
    }
  }
  private abandon(code: number, reason: string): void {
    this.lifetime.abort(); this.records.length = 0; this.pendingBytes = 0;
    if (!this.running) this.cleanup();
    this.socket.close?.(code, reason);
  }
  private enqueue(bytes: Buffer): void {
    this.directory ??= mkdtempSync(join(tmpdir(), `${OUTBOX_DIRECTORY_PREFIX}${process.pid}-`));
    let file = this.files.at(-1);
    // Every record of the newest file was taken already (each is read before it
    // is released): write from its start again instead of rolling to a new file
    // and leaving this one on disk until the drain ends. Only a file that still
    // holds records is ever rolled past, and release() removes it once emptied.
    if (file !== undefined && file.pending === 0) file.written = 0;
    if (file === undefined || file.written >= SPILL_FILE_BYTES) {
      const path = join(this.directory, `outbox-${this.fileCount++}`);
      file = { fd: openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600), path, written: 0, pending: 0 };
      this.files.push(file);
    }
    const offset = file.written;
    let written = 0;
    while (written < bytes.length) written += writeSync(file.fd, bytes, written, bytes.length - written, offset + written);
    file.written += bytes.length;
    file.pending += 1;
    this.records.push({ file, offset, length: bytes.length });
    this.pendingBytes += bytes.length;
  }

  /**
   * A spill file whose records have all been taken, and that takes no new ones,
   * is closed and removed. The newest one stays open and is written from its
   * start again by the next enqueue.
   */
  private release(file: SpillFile): void {
    file.pending -= 1;
    if (file.pending > 0 || file === this.files.at(-1)) return;
    this.files.splice(this.files.indexOf(file), 1);
    closeSync(file.fd);
    rmSync(file.path, { force: true });
  }
  /** Sends `first` (the rest of a message that never touched disk) and then every spilled record, in order. */
  private async drain(first?: Iterable<string>): Promise<void> {
    this.running = true;
    let stall: AbortSignal | undefined;
    try {
      let text: string | Iterable<string> | undefined = first;
      while (!this.lifetime.signal.aborted) {
        if (text === undefined) {
          const record = this.records.shift();
          if (record === undefined) break;
          this.pendingBytes -= record.length;
          const bytes = Buffer.alloc(record.length);
          let read = 0;
          while (read < bytes.length) {
            const n = readSync(record.file.fd, bytes, read, bytes.length - read, record.offset + read);
            if (!n) throw new Error('Incomplete WebSocket outbox');
            read += n;
          }
          this.release(record.file);
          text = bytes.toString('utf8');
        }
        stall = AbortSignal.timeout(this.stallTimeoutMs);
        await sendWebSocketMessage(this.socket, text, AbortSignal.any([this.lifetime.signal, stall]));
        text = undefined;
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
    for (const file of this.files.splice(0)) closeSync(file.fd);
    if (this.directory !== undefined) { rmSync(this.directory, { recursive: true, force: true }); this.directory = undefined; }
  }
}

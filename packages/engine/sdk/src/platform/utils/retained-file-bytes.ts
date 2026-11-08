/** Exact admitted bytes with bounded working memory. The private backing file
 * is unlinked before publication; only its owner's read-only descriptor lives.
 * No plaintext path, content fingerprint or reusable authority is exported.
 */
import { closeSync, constants, fstatSync, openSync, read, unlinkSync, type BigIntStats } from 'node:fs';
import { lstat, mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHUNK_BYTES = 64 * 1024;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export interface RetainedFileSlice { readonly kind: 'retained-file-slice' }
export interface RetainedFileCapture {
  capture(path: string, signal?: AbortSignal): Promise<RetainedFileSlice>;
}
type Range = { readonly offset: number; readonly length: number };
const sameFile = (a: BigIntStats, b: BigIntStats) => a.isFile() && b.isFile()
  && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
const readAt = (fd: number, buffer: Buffer, length: number, position: number): Promise<number> =>
  new Promise((resolve, reject) => read(fd, buffer, 0, length, position, (error, bytes) => error ? reject(error) : resolve(bytes)));

async function writeAll(handle: FileHandle, bytes: Buffer, length: number, position: number, signal?: AbortSignal): Promise<void> {
  let written = 0;
  while (written < length) {
    signal?.throwIfAborted();
    const part = await handle.write(bytes, written, length - written, position + written);
    if (part.bytesWritten <= 0) throw new Error('File snapshot write made no progress');
    written += part.bytesWritten;
  }
}

/** One descriptor per bundle, with private ranges for each admitted file. */
export class RetainedFileBytes {
  #fd: number | undefined;
  readonly #identity: BigIntStats;
  readonly #ranges: WeakMap<RetainedFileSlice, Range>;

  private constructor(fd: number, ranges: WeakMap<RetainedFileSlice, Range>) {
    this.#fd = fd;
    this.#identity = fstatSync(fd, { bigint: true });
    this.#ranges = ranges;
  }

  /** Collection is sequential. A failed/cancelled collection owns and removes
   * all partial bytes before rejecting. Call close() when its actual owner ends.
   */
  static async capture<T>(collect: (writer: RetainedFileCapture) => Promise<T>, signal?: AbortSignal): Promise<{ files: RetainedFileBytes; value: T }> {
    signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), 'captured-input-bytes-'));
    const path = join(directory, 'bytes');
    let writer: FileHandle | undefined, fd: number | undefined;
    const ranges = new WeakMap<RetainedFileSlice, Range>();
    const collection = new AbortController();
    const pending = new Set<Promise<RetainedFileSlice>>();
    let offset = 0, capturing = false, collecting = true;
    try {
      signal?.throwIfAborted();
      writer = await open(path, 'wx', 0o600);
      fd = openSync(path, READ_FLAGS);
      if (!sameFile(await writer.stat({ bigint: true }), fstatSync(fd, { bigint: true }))) throw new Error('File snapshot backing file changed');
      // Unlink before collecting any payload. Even a killed process leaves no
      // large partial runtime/dependency snapshot in the temporary directory.
      unlinkSync(path);
      await rm(directory, { recursive: true, force: true });
      const handle = writer;
      const capture = async (source: string, current?: AbortSignal): Promise<RetainedFileSlice> => {
        const active = AbortSignal.any([collection.signal, ...[signal, current].filter((value): value is AbortSignal => value !== undefined)]);
        active.throwIfAborted();
        if (!collecting || capturing) throw new Error('File snapshots must be collected sequentially');
        capturing = true;
        try {
          const input = await open(source, READ_FLAGS);
          try {
            const before = await input.stat({ bigint: true });
            if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER - offset)) throw new Error('Unsupported file snapshot size or kind');
            const length = Number(before.size), chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, length));
            let count = 0;
            while (count < length) {
              active?.throwIfAborted();
              const part = await input.read(chunk, 0, Math.min(chunk.length, length - count), count);
              if (part.bytesRead <= 0) throw new Error('File changed while capturing bytes');
              await writeAll(handle, chunk, part.bytesRead, offset + count, active);
              count += part.bytesRead;
            }
            active?.throwIfAborted();
            if (!sameFile(before, await input.stat({ bigint: true })) || !sameFile(before, await lstat(source, { bigint: true }))) {
              throw new Error('File changed while capturing bytes');
            }
            const slice = Object.freeze({ kind: 'retained-file-slice' as const });
            ranges.set(slice, { offset, length }); offset += length;
            return slice;
          } finally { await input.close(); }
        } finally { capturing = false; }
      };
      const value = await collect(Object.freeze({ capture(source: string, current?: AbortSignal) {
        const work = capture(source, current);
        pending.add(work);
        void work.then(() => pending.delete(work), () => pending.delete(work));
        return work;
      } }));
      collecting = false;
      if (capturing || pending.size) throw new Error('File snapshot collection did not join its capture');
      signal?.throwIfAborted();
      const identity = await writer.stat({ bigint: true });
      await writer.chmod(0o400);
      const sealed = await writer.stat({ bigint: true });
      if (identity.size !== BigInt(offset) || sealed.size !== BigInt(offset)) throw new Error('File snapshot length changed');
      await writer.close(); writer = undefined;
      signal?.throwIfAborted();
      if (!sameFile(sealed, fstatSync(fd, { bigint: true }))) throw new Error('File snapshot backing file changed');
      signal?.throwIfAborted();
      const files = new RetainedFileBytes(fd, ranges); fd = undefined;
      return { files, value };
    } finally {
      collecting = false;
      collection.abort();
      await Promise.allSettled([...pending]);
      try { if (writer) await writer.close(); }
      finally {
        try { if (fd !== undefined) closeSync(fd); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  }

  private selected(slice: RetainedFileSlice): { fd: number; range: Range } {
    const fd = this.#fd, range = this.#ranges.get(slice);
    if (fd === undefined || !range || !sameFile(this.#identity, fstatSync(fd, { bigint: true }))) throw new Error('Retained file bytes are unavailable or changed');
    return { fd, range };
  }

  private assertSelected(slice: RetainedFileSlice, fd: number, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.selected(slice).fd !== fd) throw new Error('Retained file bytes owner changed');
  }

  /** Compare complete bytes, including invalid UTF-8, using at most 128 KiB. */
  async matchesFile(slice: RetainedFileSlice, path: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const { fd, range } = this.selected(slice);
    const candidate = await open(path, READ_FLAGS);
    try {
      const before = await candidate.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(range.length)) return false;
      const expected = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, range.length));
      const actual = Buffer.allocUnsafe(expected.length);
      let offset = 0;
      while (offset < range.length) {
        this.assertSelected(slice, fd, signal);
        const length = Math.min(expected.length, range.length - offset);
        let a = 0, b = 0;
        while (a < length) {
          this.assertSelected(slice, fd, signal);
          const count = await readAt(fd, expected.subarray(a), length - a, range.offset + offset + a);
          if (!count) throw new Error('Retained file bytes were truncated');
          a += count;
        }
        while (b < length) {
          this.assertSelected(slice, fd, signal);
          const { bytesRead } = await candidate.read(actual, b, length - b, offset + b);
          if (!bytesRead) throw new Error('File changed while comparing bytes');
          b += bytesRead;
        }
        if (!expected.subarray(0, length).equals(actual.subarray(0, length))) return false;
        offset += length;
      }
      this.assertSelected(slice, fd, signal);
      if (!sameFile(before, await candidate.stat({ bigint: true })) || !sameFile(before, await lstat(path, { bigint: true }))) throw new Error('File changed while comparing bytes');
      this.assertSelected(slice, fd, signal);
      return true;
    } finally { await candidate.close(); }
  }

  /** Materialize admitted bytes with bounded memory. The staging caller checks
   * matchesFile afterwards, before admitting that destination to execution.
   */
  async copyTo(slice: RetainedFileSlice, path: string, mode: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const { fd, range } = this.selected(slice);
    const output = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode);
    try {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, range.length));
      let offset = 0;
      while (offset < range.length) {
        this.assertSelected(slice, fd, signal);
        const length = await readAt(fd, chunk, Math.min(chunk.length, range.length - offset), range.offset + offset);
        if (!length) throw new Error('Retained file bytes were truncated');
        this.assertSelected(slice, fd, signal);
        await writeAll(output, chunk, length, offset, signal);
        offset += length;
      }
      this.assertSelected(slice, fd, signal);
      await output.chmod(mode);
    } finally { await output.close(); }
  }

  close(): void {
    const fd = this.#fd;
    this.#fd = undefined;
    if (fd !== undefined) closeSync(fd);
  }
}

import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { redactStructuredDataAsync, type StructuredRedactionOptions } from '@goodvibes-jev/engine/platform/platform/utils';

export interface ArtifactPackageEntry {
  readonly path: string;
  readonly buffer: Buffer;
  /** Already-compressed media is stored, not deflated again. */
  readonly mimeType?: string | undefined;
}

const deflateRawAsync = promisify(deflateRaw);

const SENSITIVE_METADATA_KEY = /token|secret|password|authorization|credential|api[-_]?key/i;

/** Apply canonical field withholding and semantic text egress to outbound metadata. */
export async function prepareArtifactMetadata(value: unknown, options: StructuredRedactionOptions = {}): Promise<unknown> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const result = await redactStructuredDataAsync(value, { ...options, purpose: 'export' });
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  return result;
}

export function sanitizeArtifactMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeArtifactMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_METADATA_KEY.test(key) ? '<redacted>' : sanitizeArtifactMetadata(entry),
  ]));
}

export function sanitizeArtifactSourceUri(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return '[REDACTED]';
    url.username = '';
    url.password = '';
    // Parameter names cannot establish that their values are public.
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]');
    if (url.hash) url.hash = '[REDACTED]';
    return url.toString();
  } catch {
    return '[REDACTED]';
  }
}

export function safeArtifactExportFilename(artifact: ArtifactDescriptor): string {
  const filename = (artifact.filename || artifact.id).trim() || artifact.id;
  return filename.replace(/[\\/]+/g, '-').replace(/^\.+$/, artifact.id);
}

function safePackagePathSegment(value: string, fallback: string): string {
  const sanitized = value
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1F]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+$/, '');
  const normalized = sanitized || fallback;
  return normalized.length > 128 ? normalized.slice(0, 128).trimEnd() : normalized;
}

export function packageArtifactFilename(
  artifact: ArtifactDescriptor,
  index: number,
  used: Set<string>,
): string {
  const ordinal = String(index + 1).padStart(2, '0');
  const id = safePackagePathSegment(artifact.id, `artifact-${ordinal}`);
  const filename = safePackagePathSegment(safeArtifactExportFilename(artifact), id);
  const base = `${ordinal}-${id}-${filename}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function dosTimestamp(date = new Date()): { readonly time: number; readonly date: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** The largest size or offset a ZIP without the ZIP64 extension can record. */
export const ZIP_MAX_BYTES = 0xffffffff;
/** The most entries a ZIP without the ZIP64 extension can record. */
export const ZIP_MAX_ENTRIES = 0xffff;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;

/**
 * Media and archive formats that are already compressed: deflating them again
 * costs time and saves nothing, so they are stored as they are.
 */
const ALREADY_COMPRESSED = /^(?:image\/(?:png|jpe?g|gif|webp|avif|heic|heif)|video\/|audio\/(?:mpeg|mp4|aac|ogg|opus|webm|flac)|application\/(?:zip|gzip|x-gzip|x-7z-compressed|x-xz|x-bzip2|zstd|pdf|epub\+zip|vnd\.openxmlformats-officedocument\.[\w.-]+))$/i;

export function isAlreadyCompressed(mimeType: string | undefined): boolean {
  return typeof mimeType === 'string' && ALREADY_COMPRESSED.test(mimeType.trim());
}

/**
 * The most bytes a ZIP of these entries can take: each entry's bytes plus the
 * few bytes per block deflate can add, its name and headers twice, and `slack`
 * for anything written after (a manifest). Used to refuse an archive that cannot
 * fit before anything is read.
 */
export function zipSizeBound(entries: readonly { readonly path: string; readonly sizeBytes: number }[], slack = 0): number {
  let total = END_RECORD_BYTES + slack;
  for (const entry of entries) {
    const name = Buffer.byteLength(entry.path.replace(/\\/g, '/'), 'utf-8');
    total += LOCAL_HEADER_BYTES + CENTRAL_HEADER_BYTES + 2 * name + entry.sizeBytes + Math.ceil(entry.sizeBytes / 16_384) * 5 + 16;
  }
  return total;
}

/** Where finished ZIP bytes go, in order. */
export interface ZipSink {
  write(chunk: Buffer): Promise<void>;
}

/**
 * Writes a ZIP one entry at a time: each entry's bytes go to the sink as soon as
 * it is added, so only the entry being added is held in memory. Compression runs
 * off the event loop.
 */
export class ZipWriter {
  readonly #sink: ZipSink;
  readonly #central: Buffer[] = [];
  readonly #timestamp = dosTimestamp();
  #offset = 0;
  #count = 0;
  #finished = false;

  constructor(sink: ZipSink) {
    this.#sink = sink;
  }

  /** Bytes written so far. */
  get bytesWritten(): number {
    return this.#offset;
  }

  async add(path: string, data: Buffer, options: { readonly mimeType?: string | undefined } = {}): Promise<void> {
    if (this.#finished) throw new Error('The archive is already finished.');
    if (this.#count >= ZIP_MAX_ENTRIES) throw new Error('Artifact archive has too many files for ZIP output.');
    const safePath = path.replace(/\\/g, '/');
    const name = Buffer.from(safePath, 'utf-8');
    if (name.byteLength > 0xffff) throw new Error(`Artifact archive entry path is too long: ${safePath}`);
    if (data.byteLength > ZIP_MAX_BYTES) throw new Error(`Artifact archive entry is too large for ZIP output: ${safePath}`);
    const stored = isAlreadyCompressed(options.mimeType);
    const body = stored ? data : await deflateRawAsync(data);
    if (body.byteLength > ZIP_MAX_BYTES) throw new Error(`Artifact archive entry is too large for ZIP output: ${safePath}`);
    const checksum = crc32(data) >>> 0;
    const method = stored ? 0 : 8;
    // Without the UTF-8 flag (bit 11) unzip tools read names as CP437 and garble
    // anything outside ASCII. ASCII names keep the plain flags.
    const flags = /^[\x00-\x7f]*$/.test(safePath) ? 0 : 0x0800;
    const offset = this.#offset;
    if (offset + LOCAL_HEADER_BYTES + name.byteLength + body.byteLength > ZIP_MAX_BYTES) throw new Error('Artifact archive is too large for ZIP output.');

    const localHeader = Buffer.alloc(LOCAL_HEADER_BYTES);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(this.#timestamp.time, 10);
    localHeader.writeUInt16LE(this.#timestamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(body.byteLength, 18);
    localHeader.writeUInt32LE(data.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(CENTRAL_HEADER_BYTES);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(this.#timestamp.time, 12);
    centralHeader.writeUInt16LE(this.#timestamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(body.byteLength, 20);
    centralHeader.writeUInt32LE(data.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    await this.#sink.write(Buffer.concat([localHeader, name]));
    await this.#sink.write(body);
    this.#central.push(centralHeader, name);
    this.#offset = offset + LOCAL_HEADER_BYTES + name.byteLength + body.byteLength;
    this.#count += 1;
  }

  /** Writes the central directory and the end record; returns the archive's size in bytes. */
  async finish(): Promise<number> {
    if (this.#finished) throw new Error('The archive is already finished.');
    this.#finished = true;
    const centralDirectory = Buffer.concat(this.#central);
    if (this.#offset + centralDirectory.byteLength + END_RECORD_BYTES > ZIP_MAX_BYTES) throw new Error('Artifact archive is too large for ZIP output.');
    const endOfCentralDirectory = Buffer.alloc(END_RECORD_BYTES);
    endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
    endOfCentralDirectory.writeUInt16LE(0, 4);
    endOfCentralDirectory.writeUInt16LE(0, 6);
    endOfCentralDirectory.writeUInt16LE(this.#count, 8);
    endOfCentralDirectory.writeUInt16LE(this.#count, 10);
    endOfCentralDirectory.writeUInt32LE(centralDirectory.byteLength, 12);
    endOfCentralDirectory.writeUInt32LE(this.#offset, 16);
    endOfCentralDirectory.writeUInt16LE(0, 20);
    await this.#sink.write(Buffer.concat([centralDirectory, endOfCentralDirectory]));
    this.#offset += centralDirectory.byteLength + END_RECORD_BYTES;
    return this.#offset;
  }
}

/** A whole ZIP in memory, for small archives that are saved as one artifact. */
export async function createZipArchive(entries: readonly ArtifactPackageEntry[]): Promise<Buffer> {
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error('Artifact archive has too many files for ZIP output.');
  const parts: Buffer[] = [];
  const zip = new ZipWriter({ async write(chunk) { parts.push(chunk); } });
  for (const entry of entries) await zip.add(entry.path, entry.buffer, { mimeType: entry.mimeType });
  await zip.finish();
  return Buffer.concat(parts);
}

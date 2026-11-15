/**
 * bundle-archive.ts
 *
 * A capability bundle is one pinned byte stream: a tar archive (what `git
 * archive` produces, and what `tar -cf` makes) whose member
 * {@link BUNDLE_MANIFEST_MEMBER} is the capability manifest and whose other
 * regular files are the payload installed under the entry's directory. A bare
 * manifest (the bytes are the JSON document itself) is a bundle with no payload.
 *
 * Only what installs as plain files is accepted: regular files and directories.
 * A link, a device, an absolute path or a path that climbs out with `..` is
 * refused, so unpacking can never write outside the install directory.
 */

/** The archive member that holds the capability manifest. */
export const BUNDLE_MANIFEST_MEMBER = 'goodvibes-bundle.json';

/** The unpacked contents of a verified bundle. */
export interface BundleArchive {
  /** The manifest document, still unvalidated. */
  readonly manifest: unknown;
  /** Payload files by relative path (the manifest member included, so it is installed beside them). */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

const BLOCK = 512;
const decoder = new TextDecoder();

function field(header: Uint8Array, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return decoder.decode(end === -1 ? raw : raw.subarray(0, end));
}

function octal(header: Uint8Array, offset: number, length: number): number {
  const text = field(header, offset, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('bundle archive has a malformed size field');
  return text ? parseInt(text, 8) : 0;
}

/** A member path as it will be written under the install directory, or an error for one that could escape it. */
function safeMemberPath(raw: string): string {
  const path = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!path) return '';
  if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`bundle archive member '${raw}' is refused: members must be relative paths inside the bundle`);
  }
  return path;
}

/** Path overrides carried by a pax extended header (`path=` records). */
function paxPath(data: Uint8Array): string | undefined {
  const text = decoder.decode(data);
  let found: string | undefined;
  for (let index = 0; index < text.length;) {
    const space = text.indexOf(' ', index);
    if (space === -1) break;
    const length = Number(text.slice(index, space));
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, index + length - 1);
    if (record.startsWith('path=')) found = record.slice('path='.length);
    index += length;
  }
  return found;
}

function readTar(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + BLOCK;
    if (dataStart + size > bytes.length) throw new Error('bundle archive is truncated');
    const data = bytes.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') { nextPath = paxPath(data); continue; }
    if (type === 'g') continue; // global header (git archive writes the commit id here)
    const prefix = field(header, 345, 155);
    const name = nextPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    nextPath = undefined;
    if (type === '5') { safeMemberPath(name); continue; }
    if (type !== '0' && type !== '\0') {
      throw new Error(`bundle archive member '${name}' is refused: only regular files and directories are installed`);
    }
    const path = safeMemberPath(name);
    if (!path) continue;
    files.set(path, data.slice());
  }
  return files;
}

/** True when the bytes look like a tar archive (the ustar magic at its fixed offset). */
function isTar(bytes: Uint8Array): boolean {
  return bytes.length >= BLOCK && decoder.decode(bytes.subarray(257, 262)) === 'ustar';
}

/**
 * Read verified bundle bytes. Throws with a plain reason when the bytes are
 * neither a tar archive holding {@link BUNDLE_MANIFEST_MEMBER} nor a bare JSON
 * manifest, or when a member could escape the install directory.
 */
export function readBundleArchive(bytes: Uint8Array): BundleArchive {
  if (!isTar(bytes)) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(decoder.decode(bytes));
    } catch {
      throw new Error(`the bundle is neither a tar archive holding ${BUNDLE_MANIFEST_MEMBER} nor a JSON manifest`);
    }
    return { manifest, files: new Map([[BUNDLE_MANIFEST_MEMBER, bytes]]) };
  }
  const files = readTar(bytes);
  const manifestBytes = files.get(BUNDLE_MANIFEST_MEMBER);
  if (!manifestBytes) throw new Error(`the bundle archive has no ${BUNDLE_MANIFEST_MEMBER} at its top level`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(decoder.decode(manifestBytes));
  } catch {
    throw new Error(`the bundle's ${BUNDLE_MANIFEST_MEMBER} is not valid JSON`);
  }
  return { manifest, files };
}

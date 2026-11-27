/**
 * carried-files.ts, a file or folder named by path by a caller whose program is on another machine: the program reads
 * it there and sends its content with the call, and writes back what the run leaves (terminal-shell
 * bundle-file-work.ts `carryFilesHere`). The daemon never reads or writes a path of that machine: it puts what was sent
 * in a scratch folder of its own for the one call, runs the capability on that scratch path (path-inputs.ts takes a path
 * inside it as the content sent), and returns each file or folder the run made or changed there. One mechanism for
 * every capability with a path input, text and binary files and whole folders alike (a folder travels as one archive:
 * `packFolder`, `unpackFolder`, the same code on both sides).
 *
 * Who may carry is the daemon's to decide (routes/capabilities.ts): a caller on another machine, or the owner's own
 * program. Whose file it is, and on which machine, is said on the owner's card from the principal the daemon
 * authenticated, never from anything the caller sent (`machine` is not read). The scratch folders are in the daemon's
 * home, owner-only (`carriedBase`), never the shared temp folder, and live only as long as the call. Content larger than one
 * request body carries travels ahead as uploads in parts (`CARRIED_UPLOAD_PURPOSE`, `uploadCarriedParts`), named in
 * the call by their ids.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { CapabilityRefusal, type CapabilityEntry } from './types.js';

/**
 * The capabilities whose path names a place the daemon keeps using, not a file to read or write once (a workspace, a
 * project given to a device, where a hosted agent works, a tool server's folders, a file a memory is about, the paths a
 * task would write, a folder published by link): never carried, so from another machine they stay refused
 * (path-inputs.ts), as a copy in a scratch folder would be a place that is gone after the call.
 */
export const PLACE_PATH_CAPABILITIES: ReadonlySet<string> = new Set([
  'workspaces.register', 'workspaces.unregister', 'devices.give-project', 'devices.take-project', 'agents.host', 'mcp.add',
  'memory.add', 'memory.explain', 'skills.publish-local', 'plugin.publish-local',
]);

/** The most a call carries each way, files and folders together. */
export const MAX_CARRIED_BYTES = 64 * 1024 * 1024;
/** The most files one carried folder holds. */
export const MAX_FOLDER_FILES = 10_000;
/**
 * The most a call body carries inline: past it the program sends the content ahead as uploads in parts
 * (`uploadCarriedParts`), each well inside the daemon's limit for one method body (1 MiB).
 */
export const CARRIED_INLINE_BYTES = 512 * 1024;
/** The bytes of one uploaded part (its base64 form stays under the daemon's 1 MiB method body). */
export const CARRIED_PART_BYTES = 512 * 1024;
/** The purpose an uploaded part carries (artifact metadata): the daemon reads, and removes, only such an upload. */
export const CARRIED_UPLOAD_PURPOSE = 'carried-file';
/**
 * How many uploaded parts whose call has not read them yet the daemon keeps (it removes each once read): past it, the
 * oldest go (a program that ended between sending its parts and its call). 1024 parts is 512 MiB, eight calls at the most
 * one call carries; nothing is removed because time went by.
 */
export const CARRIED_UPLOADS_KEPT = 1024;
/** The archive form a folder travels in. */
const FOLDER_FORMAT = 'goodvibes-folder-v1';

/**
 * One path input's content as it travels: a file's bytes, a folder as one archive, or nothing there yet. `machine`: a
 * host name an older program sends; never read (whose machine it is, is the authenticated caller's).
 */
export type CarriedContent =
  | { readonly kind: 'file'; readonly name: string; readonly base64: string; readonly machine?: string }
  | { readonly kind: 'folder'; readonly name: string; readonly archive: FolderArchive; readonly machine?: string }
  | { readonly kind: 'absent'; readonly name: string; readonly machine?: string };

/**
 * Content sent ahead of the call as uploads in parts (`uploadCarriedParts`): a file's bytes, or a folder's archive as
 * JSON, cut into parts, each an upload whose id is named here in order.
 */
export type CarriedParts =
  | { readonly kind: 'file'; readonly name: string; readonly parts: readonly string[] }
  | { readonly kind: 'folder'; readonly name: string; readonly archiveParts: readonly string[] };

/** What the daemon reads an uploaded part with, and removes it once read (the daemon's artifact store). */
export interface CarriedUploads {
  /** The bytes of an upload made for a carried call (`CARRIED_UPLOAD_PURPOSE`); refused for any other upload. */
  read(id: string): Promise<Buffer>;
  drop(id: string): void;
}

/** A folder as one archive: every regular file under it by its path relative to the folder (links are left out). */
export interface FolderArchive {
  readonly format: typeof FOLDER_FORMAT;
  readonly files: readonly { readonly path: string; readonly base64: string }[];
}

/** A relative path inside a folder, as an archive names it: never absolute, never above the folder. */
function safeRelative(path: string): string | undefined {
  if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.includes('\0')) return undefined;
  const clean = normalize(path.replace(/\\/g, '/')).replace(/\\/g, '/');
  if (clean === '.' || clean.startsWith('../') || clean === '..' || clean.split('/').includes('..')) return undefined;
  return clean;
}

/** A folder's regular files as one archive; a link is not followed and not carried. Refused past the limits. */
export function packFolder(root: string, budget = MAX_CARRIED_BYTES): FolderArchive {
  const files: { path: string; base64: string }[] = [];
  let bytes = 0;
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(full, rel); continue; }
      if (!entry.isFile()) continue;
      const content = readFileSync(full);
      bytes += content.length;
      if (bytes > budget || files.length >= MAX_FOLDER_FILES) {
        throw new CapabilityRefusal(`The folder ${basename(root)} is larger than one call carries (${Math.round(budget / 1024 / 1024)} MiB, ${MAX_FOLDER_FILES} files); nothing was sent.`);
      }
      files.push({ path: rel, base64: content.toString('base64') });
    }
  };
  walk(root, '');
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { format: FOLDER_FORMAT, files };
}

/** Write an archive's files under `root` (made if missing); a path that would leave the folder is refused. */
export function unpackFolder(root: string, archive: unknown): number {
  const files = readArchive(archive);
  mkdirSync(root, { recursive: true });
  for (const file of files) {
    const target = join(root, ...file.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(file.base64, 'base64'));
  }
  return files.length;
}

/**
 * An archive's files, read before anything is written: never more files than one folder carries, never more bytes, no
 * path outside the folder. Refused whole past any limit, so nothing of it is unpacked.
 */
function readArchive(archive: unknown): readonly { readonly path: string; readonly base64: string }[] {
  const value = archive as Partial<FolderArchive> | null;
  if (value === null || typeof value !== 'object' || value.format !== FOLDER_FORMAT || !Array.isArray(value.files)) {
    throw new CapabilityRefusal('The folder that was sent is not one GoodVibes reads; nothing was done.');
  }
  if (value.files.length > MAX_FOLDER_FILES) {
    throw new CapabilityRefusal(`The folder that was sent holds ${value.files.length} files, more than one call carries (${MAX_FOLDER_FILES.toLocaleString('en-US')} files); nothing was done.`);
  }
  let bytes = 0;
  return value.files.map((file) => {
    const path = safeRelative((file as { path?: unknown }).path as string);
    const base64 = (file as { base64?: unknown }).base64;
    if (path === undefined || typeof base64 !== 'string') throw new CapabilityRefusal('The folder that was sent names a file outside itself; nothing was done.');
    bytes += Math.floor(base64.length * 3 / 4);
    if (bytes > MAX_CARRIED_BYTES) throw new CapabilityRefusal(`The folder that was sent is larger than one call carries (${MAX_CARRIED_BYTES / 1024 / 1024} MiB); nothing was done.`);
    return { path, base64 };
  });
}

/** The content a path names on this machine (the program's side and the daemon's scratch side alike). */
export function contentAt(path: string, name: string, budget = MAX_CARRIED_BYTES): CarriedContent {
  if (!existsSync(path)) return { kind: 'absent', name };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new CapabilityRefusal(`${name} is a link; only a file or a folder is sent.`);
  if (stat.isDirectory()) return { kind: 'folder', name, archive: packFolder(path, budget) };
  if (!stat.isFile()) throw new CapabilityRefusal(`${name} is not a file or a folder; nothing was sent.`);
  if (stat.size > budget) throw new CapabilityRefusal(`${name} is larger than one call carries (${Math.round(budget / 1024 / 1024)} MiB); nothing was sent.`);
  return { kind: 'file', name, base64: readFileSync(path).toString('base64') };
}

/** A path's real form (a link above it followed), or the path itself when it cannot be read. */
function realPathOrSelf(path: string): string {
  try { return realpathSync(path); } catch {
    try { return join(realpathSync(dirname(path)), basename(path)); } catch { return path; }
  }
}

/** Whether two contents are the same (what came back is what was sent: nothing to write). */
export function sameContent(a: CarriedContent | undefined, b: CarriedContent): boolean {
  if (a === undefined || a.kind !== b.kind) return false;
  if (a.kind === 'file' && b.kind === 'file') return a.base64 === b.base64;
  if (a.kind === 'folder' && b.kind === 'folder') return JSON.stringify(a.archive) === JSON.stringify(b.archive);
  return a.kind === 'absent';
}

/** Put one content at `path` (a file's bytes, a folder's files); `absent` writes nothing. */
export function placeContent(path: string, content: CarriedContent): void {
  if (content.kind === 'file') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(content.base64, 'base64'));
  } else if (content.kind === 'folder') {
    unpackFolder(path, content.archive);
  }
}

/** The ids of uploaded parts, in order: at least one, each a short id. */
function partIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > Math.ceil(MAX_CARRIED_BYTES / CARRIED_PART_BYTES) * 2) return undefined;
  return value.every((id) => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(id)) ? value as string[] : undefined;
}

/** A content as sent: inline, or in uploaded parts (read later, `resolveParts`). The name is any text, never trusted. */
function readCarried(value: unknown): CarriedContent | CarriedParts | undefined {
  const content = value as Partial<{ kind: unknown; name: unknown; base64: unknown; archive: unknown; parts: unknown; archiveParts: unknown }> | null;
  if (content === null || typeof content !== 'object' || typeof content.name !== 'string') return undefined;
  const name = content.name;
  if (content.kind === 'file' && typeof content.base64 === 'string') return { kind: 'file', name, base64: content.base64 };
  if (content.kind === 'file' && partIds(content.parts)) return { kind: 'file', name, parts: partIds(content.parts)! };
  if (content.kind === 'folder' && partIds(content.archiveParts)) return { kind: 'folder', name, archiveParts: partIds(content.archiveParts)! };
  if (content.kind === 'folder') { readArchive(content.archive); return { kind: 'folder', name, archive: content.archive as FolderArchive }; }
  if (content.kind === 'absent') return { kind: 'absent', name };
  return undefined;
}

/** Content sent in parts, read from its uploads (each removed once read), refused past the limits. */
async function resolveParts(sent: CarriedParts, uploads: CarriedUploads | undefined): Promise<CarriedContent> {
  const ids = sent.kind === 'file' ? sent.parts : sent.archiveParts;
  if (!uploads) throw new CapabilityRefusal('The files sent with the call were sent ahead in parts, which this daemon cannot read; nothing was done.');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (const id of ids) {
      let chunk: Buffer;
      try { chunk = await uploads.read(id); } catch {
        throw new CapabilityRefusal(`A part of the file sent for this call (${id}) is not one sent for a call; nothing was done.`);
      }
      total += chunk.byteLength;
      if (total > MAX_CARRIED_BYTES * (sent.kind === 'folder' ? 1.4 : 1)) throw new CapabilityRefusal(`The files sent are larger than one call carries (${MAX_CARRIED_BYTES / 1024 / 1024} MiB); nothing was done.`);
      chunks.push(chunk);
    }
  } finally {
    for (const id of ids) { try { uploads.drop(id); } catch { /* gone already */ } }
  }
  const bytes = Buffer.concat(chunks);
  if (sent.kind === 'file') return { kind: 'file', name: sent.name, base64: bytes.toString('base64') };
  let archive: unknown;
  try { archive = JSON.parse(bytes.toString('utf8')) as unknown; } catch {
    throw new CapabilityRefusal('The folder that was sent is not one GoodVibes reads; nothing was done.');
  }
  readArchive(archive);
  return { kind: 'folder', name: sent.name, archive: archive as FolderArchive };
}

/**
 * The content of each path input, sent ahead in parts when the call would be larger than one request body carries
 * (the program's side: terminal-shell bundle-file-work.ts). `upload` stores one part (its bytes, a name) with the
 * daemon and answers its id; each part carries `CARRIED_UPLOAD_PURPOSE`, so the daemon reads and removes only it.
 */
export async function uploadCarriedParts(carried: Readonly<Record<string, CarriedContent>>, upload: (bytes: Buffer, name: string) => Promise<string>): Promise<Record<string, CarriedContent | CarriedParts>> {
  const size = Object.values(carried).reduce((sum, content) => sum + (content.kind === 'file' ? content.base64.length : content.kind === 'folder' ? JSON.stringify(content.archive).length : 0), 0);
  if (size <= CARRIED_INLINE_BYTES) return { ...carried };
  const out: Record<string, CarriedContent | CarriedParts> = {};
  for (const [id, content] of Object.entries(carried)) {
    if (content.kind === 'absent') { out[id] = content; continue; }
    const bytes = content.kind === 'file' ? Buffer.from(content.base64, 'base64') : Buffer.from(JSON.stringify(content.archive), 'utf8');
    const parts: string[] = [];
    for (let at = 0; at < bytes.byteLength || parts.length === 0; at += CARRIED_PART_BYTES) {
      parts.push(await upload(bytes.subarray(at, at + CARRIED_PART_BYTES), `${basename(content.name) || 'file'}.part${parts.length + 1}`));
    }
    out[id] = content.kind === 'file' ? { kind: 'file', name: content.name, parts } : { kind: 'folder', name: content.name, archiveParts: parts };
  }
  return out;
}

/**
 * A caller's name for its file, as the owner's card shows it: one line, quoted by the card, at most 160 characters.
 * Control characters and line breaks are taken out; a name longer than the cap ends in "…".
 */
export function carriedNameShown(name: string): string {
  const line = name.replace(/[\u0000-\u001f\u007f-\u009f\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim() || 'a file with no name';
  return line.length <= 160 ? line : `${line.slice(0, 159)}…`;
}

/** What a content is, as a digest: what came back is compared with what was sent by it. */
function digestOf(content: CarriedContent): string {
  const hash = createHash('sha256').update(content.kind);
  if (content.kind === 'file') hash.update(content.base64);
  else if (content.kind === 'folder') hash.update(JSON.stringify(content.archive));
  return hash.digest('hex');
}

/**
 * The carried bases this process has used: a scratch folder lives as long as its call (removed when its run ends, when
 * its call is decided and refused), and a folder a process left behind (it ended mid-call)
 * belongs to nothing once that process is gone: the first use of a base in a new process removes every folder in it,
 * all of them an ended process's. Nothing is removed because time went by.
 */
const basesClearedThisProcess = new Set<string>();

/**
 * The daemon's folder of scratch folders, inside its own home (`<daemon home>/carried`), owner-only: made 0700 if
 * missing, and refused unless it is a real folder of this account (never a link, never one another account made), its
 * mode put back to 0700. On its first use in this process, the folders an earlier process left are removed.
 */
export function carriedBase(daemonHome: string): string {
  const base = join(daemonHome, 'carried');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const stat = lstatSync(base);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new CapabilityRefusal('The daemon\'s folder for files sent with a call is not its own (a link, or another account\'s); nothing was done.');
  }
  if ((stat.mode & 0o777) !== 0o700) chmodSync(base, 0o700);
  if (!basesClearedThisProcess.has(base)) {
    basesClearedThisProcess.add(base);
    for (const entry of readdirSync(base)) {
      try { rmSync(join(base, entry), { recursive: true, force: true }); } catch { /* gone already */ }
    }
  }
  return base;
}

/** A call's carried content, put in place on the daemon's machine for its run. */
export interface CarriedRun {
  /** The values with each carried path input naming its scratch path. */
  readonly values: Record<string, string>;
  /** The scratch folder (CapabilityCaller.carried). */
  readonly roots: readonly string[];
  /** Each carried path input's name as the caller gave it, one line for the owner's card (`carriedNameShown`). */
  readonly names: Readonly<Record<string, string>>;
  /** The carried path inputs whose content is a folder (the card says "folder named", not "file named"). */
  readonly folders: readonly string[];
  /**
   * The values with each carried path as the caller named it (its full path, not the scratch copy's last name): what the
   * call's risk, its command-line hold and the gate are judged on, as the card shows it.
   */
  asNamed(values: Readonly<Record<string, string>>): Record<string, string>;
  /** What the run made or changed at each carried path, by input id, to send back. */
  collect(): Record<string, CarriedContent>;
  /** Words with each scratch path written as the caller named it (the answer names the caller's file, not the daemon's copy). */
  named(text: string): string;
  /** Remove the scratch folder. */
  dispose(): void;
}

/** The run over a scratch folder already holding what was sent (`placed`: input id to its path, name and digest). */
function carriedRunOver(root: string, values: Readonly<Record<string, string>>, placed: ReadonlyMap<string, { readonly path: string; readonly name: string; readonly sent: string }>): CarriedRun {
  const next: Record<string, string> = { ...values };
  for (const [id, { path }] of placed) next[id] = path;
  const names = Object.fromEntries([...placed].map(([id, { name }]) => [id, carriedNameShown(name)]));
  return {
    values: next,
    roots: [root],
    names,
    folders: [...placed].filter(([, { path }]) => { try { return lstatSync(path).isDirectory(); } catch { return false; } }).map(([id]) => id),
    asNamed: (given) => {
      const out: Record<string, string> = { ...given };
      for (const [id, { path, name }] of placed) if (out[id] === path) out[id] = name;
      return out;
    },
    collect: () => {
      const out: Record<string, CarriedContent> = {};
      for (const [id, { path, name, sent }] of placed) {
        const now = contentAt(path, name);
        if (now.kind !== 'absent' && digestOf(now) !== sent) out[id] = now;
      }
      return out;
    },
    named: (text) => {
      let out = text;
      for (const { path, name } of placed.values()) {
        for (const form of new Set([path, realPathOrSelf(path)])) out = out.split(form).join(name.replace(/[\\/]+$/, ''));
      }
      return out;
    },
    dispose: () => { rmSync(root, { recursive: true, force: true }); },
  };
}

/** Where a carried call's scratch folders are made, and how parts sent ahead are read. */
export interface CarriedReceipt {
  /** The daemon's home: the scratch folders are under `<home>/carried` (`carriedBase`). */
  readonly daemonHome: string;
  readonly uploads?: CarriedUploads | undefined;
}

/**
 * Put what the program asking sent for this call's path inputs (`carried`: input id to content, inline or in parts
 * sent ahead) in a scratch folder of the daemon's, and name it in the values; undefined when nothing was sent. A
 * carried input that is not one of the capability's path inputs, or content that is not read as one or is past the
 * limits, is refused before anything is written.
 */
export async function receiveCarried(entry: Pick<CapabilityEntry, 'id' | 'inputs'>, values: Readonly<Record<string, string>>, carried: unknown, receipt: CarriedReceipt): Promise<CarriedRun | undefined> {
  if (carried === undefined || carried === null) return undefined;
  if (typeof carried !== 'object' || Array.isArray(carried)) throw new CapabilityRefusal('The files sent with the call were not read; nothing was done.');
  const pathInputs = new Set(entry.inputs.filter((input) => input.kind === 'path').map((input) => input.id));
  const sent = Object.entries(carried as Record<string, unknown>);
  if (sent.length === 0) return undefined;
  if (PLACE_PATH_CAPABILITIES.has(entry.id)) {
    throw new CapabilityRefusal(`${entry.id} names a place on this daemon's machine, which a copy sent from another machine cannot stand for; nothing was done.`,
      'Do it from the daemon\'s own machine.');
  }
  const read: [string, CarriedContent | CarriedParts][] = [];
  for (const [id, value] of sent) {
    if (!pathInputs.has(id)) throw new CapabilityRefusal(`${entry.id} has no file input ${id}; nothing was done.`);
    const content = readCarried(value);
    if (!content) throw new CapabilityRefusal(`The file sent for ${id} was not read; nothing was done.`);
    read.push([id, content]);
  }
  let total = 0;
  const parsed: [string, CarriedContent][] = [];
  for (const [id, content] of read) {
    const whole = 'parts' in content || 'archiveParts' in content ? await resolveParts(content, receipt.uploads) : content;
    total += whole.kind === 'file' ? whole.base64.length : whole.kind === 'folder' ? JSON.stringify(whole.archive).length : 0;
    if (total > MAX_CARRIED_BYTES * 1.4) throw new CapabilityRefusal(`The files sent are larger than one call carries (${MAX_CARRIED_BYTES / 1024 / 1024} MiB); nothing was done.`);
    parsed.push([id, whole]);
  }
  const root = mkdtempSync(join(carriedBase(receipt.daemonHome), 'call-'));
  try {
    const placed = new Map<string, { readonly path: string; readonly name: string; readonly sent: string }>();
    for (const [id, content] of parsed) {
      // Named as the program named it (its last part), in a folder of its own per input.
      const leaf = basename(content.name.replace(/[\\/]+$/, '')).replace(/^\.{1,2}$/, '') || 'file';
      const path = join(root, id, leaf);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      placeContent(path, content);
      placed.set(id, { path, name: content.name, sent: digestOf(content) });
    }
    return carriedRunOver(root, values, placed);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}


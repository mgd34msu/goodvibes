/**
 * program-hashes.ts, the content hashes of the product's own programs as the daemon trusts them (gate-review-6 G7).
 *
 * The installer and the in-app update place the programs and their reader files in the install folder
 * (`~/.local/bin`, a folder every program of the account writes). The hashes the daemon judges a connecting program
 * by are not read from there: they are recorded in the daemon's own home (`program-hashes.json`, 0600, in the 0700
 * home whose every folder up to `/` only the account and root may write, daemon-home-custody.ts), by the installer
 * (`goodvibes-daemon record-installed-programs`, right after it placed the programs), by the update right after its
 * swap, and once at the first start of a daemon that finds none (an update made by a release that did not record
 * them). The daemon reads the record once, at its start, and holds it for its run: a hash added to a file in the
 * install folder later, or to the record itself while the daemon runs, changes nothing until its next start.
 *
 * What remains (docs/llms/40): a process of the account that writes the daemon's own home, with the sandbox off, can
 * write this record as it can write the daemon's other records; a model's command or file write that names the home
 * or the install folder's product files is asked in every mode (permissions/manager.ts `productHomeDirectories`).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/** The record's name in the daemon's home. */
export const PROGRAM_HASHES_NAME = 'program-hashes.json';

export type RecordedProgramKind = 'tui' | 'agent' | 'daemon';

export interface RecordedProgramHashes {
  /** sha256 of each of the product's executables, and which program it is. */
  readonly programs: ReadonlyMap<string, RecordedProgramKind>;
  /** sha256 of each library the installer placed (the sqlite-vec module), which the programs may map. */
  readonly libraries: ReadonlySet<string>;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The hashes the installer's reader files in `installFolder` name (the files it placed just now). */
export function hashesInInstallFolder(installFolder: string): RecordedProgramHashes {
  const programs = new Map<string, RecordedProgramKind>();
  const libraries = new Set<string>();
  const filesOf = (file: string): readonly { path?: unknown; sha256?: unknown }[] => {
    try {
      const parsed = JSON.parse(readFileSync(join(installFolder, file), 'utf8')) as { files?: unknown; artifact?: { files?: unknown } };
      const files = Array.isArray(parsed.files) ? parsed.files : Array.isArray(parsed.artifact?.files) ? parsed.artifact.files : [];
      return files as { path?: unknown; sha256?: unknown }[];
    } catch {
      return [];
    }
  };
  for (const [name, program] of [['goodvibes', 'tui'], ['goodvibes-agent', 'agent']] as const) {
    for (const file of filesOf(`${name}.readers.json`)) {
      if (typeof file.path !== 'string' || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) continue;
      if (new RegExp(`^${name}-[a-z0-9]+-[a-z0-9]+(?:\\.exe)?$`).test(file.path)) programs.set(file.sha256, program);
    }
  }
  for (const file of filesOf('daemon-installation.json')) {
    if (typeof file.path !== 'string' || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)) continue;
    if (file.path.startsWith('lib/')) libraries.add(file.sha256);
    // The daemon's own executable: its command line (`goodvibes-daemon do`) is one of the product's programs too.
    else if (/^goodvibes-daemon-[a-z0-9]+-[a-z0-9]+(?:\.exe)?$/.test(file.path)) programs.set(file.sha256, 'daemon');
  }
  return { programs, libraries };
}

/** Write the record into the daemon's home (0600, replaced whole), from the reader files the installer just placed. */
export function recordInstalledProgramHashes(installFolder: string, daemonHome: string): RecordedProgramHashes {
  const hashes = hashesInInstallFolder(installFolder);
  mkdirSync(daemonHome, { recursive: true, mode: 0o700 });
  const target = join(daemonHome, PROGRAM_HASHES_NAME);
  const pending = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  const body = { version: 1, recordedAt: Date.now(),
    programs: [...hashes.programs].map(([sha256, program]) => ({ program, sha256 })), libraries: [...hashes.libraries] };
  writeFileSync(pending, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(pending, target);
  return hashes;
}

/** The record in the daemon's home, or undefined when there is none (or it cannot be read as one). */
export function readRecordedProgramHashes(daemonHome: string): RecordedProgramHashes | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(daemonHome, PROGRAM_HASHES_NAME), 'utf8')); } catch { return undefined; }
  if (parsed === null || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) return undefined;
  const programs = new Map<string, RecordedProgramKind>();
  const libraries = new Set<string>();
  for (const entry of Array.isArray((parsed as { programs?: unknown }).programs) ? (parsed as { programs: unknown[] }).programs : []) {
    const { program, sha256 } = (entry ?? {}) as { program?: unknown; sha256?: unknown };
    if (typeof sha256 === 'string' && SHA256.test(sha256) && (program === 'tui' || program === 'agent' || program === 'daemon')) programs.set(sha256, program);
  }
  for (const sha256 of Array.isArray((parsed as { libraries?: unknown }).libraries) ? (parsed as { libraries: unknown[] }).libraries : []) {
    if (typeof sha256 === 'string' && SHA256.test(sha256)) libraries.add(sha256);
  }
  return { programs, libraries };
}

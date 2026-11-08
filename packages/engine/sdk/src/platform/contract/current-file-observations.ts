import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { summarizeError } from '../utils/error-display.js';
import type { ContractInputFile } from './input-snapshot.js';

const identity = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

/** Actual file identity observations shared by native checks and repair context. */
export function currentFileObservations(cwd: string, paths: readonly string[], options: {
  readonly includeText?: boolean;
  /** Exact originally captured file owner, checked again by publication's full
   * owner assertion. A blob label alone does not prove the observation's bytes.
   */
  readonly inputFile?: ContractInputFile;
} = {}): JsonValue[] {
  return [...new Set(paths)].flatMap<JsonValue>(path => {
    const parts = path.split('/');
    if (isAbsolute(path) || path.includes('\\') || parts.some(part => ['', '.', '..', '.git', '.goodvibes'].includes(part))) return [];
    try {
      if (!lstatSync(cwd).isDirectory()) return [];
      // lstat on the leaf alone still follows symlinked parent directories.
      // Current host observations must stay inside the checked physical tree.
      for (let index = 1; index < parts.length; index++)
        if (!lstatSync(join(cwd, ...parts.slice(0, index))).isDirectory()) return [];
      const absolute = join(cwd, path);
      const before = lstatSync(absolute, { bigint: true });
      if (!before.isFile()) return [];
      const expected = options.inputFile;
      const expectedOid = expected?.oid;
      if (expected && (expected.path !== path || expected.kind !== 'file' || !expectedOid || expected.identity !== identity(before)))
        throw new Error('Current file no longer belongs to the selected captured input.');
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        if (identity(fstatSync(fd, { bigint: true })) !== identity(before)) throw new Error('Current file changed before reading.');
        bytes = readFileSync(fd);
        if (BigInt(bytes.length) !== before.size || identity(fstatSync(fd, { bigint: true })) !== identity(before)
          || identity(lstatSync(absolute, { bigint: true })) !== identity(before)) throw new Error('Current file changed while reading.');
      } finally { closeSync(fd); }
      const text = options.includeText && !bytes.includes(0) ? bytes.toString('utf8') : undefined;
      return [{ operation: 'read-current-file', source: 'native-host-filesystem', success: true,
        path, bytes: bytes.length, binary: bytes.includes(0), sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(expectedOid ? { inputBlobOid: expectedOid } : {}),
        ...(text !== undefined && Buffer.from(text, 'utf8').equals(bytes) ? { text } : {}),
        meaning: 'A native read from the current checked tree, with text when requested and representable. This records the read, not semantic correctness, archive integrity, a worker execution or native approval.' }];
    } catch (error) {
      return [{ operation: 'read-current-file', source: 'native-host-filesystem', success: false, path,
        error: summarizeError(error), meaning: 'Current file identity could not be established.' }];
    }
  });
}

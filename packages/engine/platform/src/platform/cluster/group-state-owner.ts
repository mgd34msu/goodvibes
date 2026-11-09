/** Original local group path custody. These private physical observations are
 * restrictions on an admitted operation, never group identities or wire facts.
 */
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { captureExistingDirectory, writeFileAtomic } from '../utils/atomic-json-store.js';
function fileStamp(stat: BigIntStats | undefined): string | null {
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
    || (process.geteuid && stat.uid !== BigInt(process.geteuid()))) throw new Error('Group state file is not an original private regular file');
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
}
export class GroupStateOwner {
  private readonly directory: string;
  private readonly parents: Array<ReturnType<typeof captureExistingDirectory>> = [];
  private readonly missing: string[] = [];
  private readonly files = new Map<string, string | null>();
  constructor(directory: string, names: readonly string[]) {
    this.directory = isAbsolute(directory) ? directory : `${process.cwd()}${sep}${directory}`;
    let parent = this.directory;
    while (!lstatSync(parent, { bigint: true, throwIfNoEntry: false })) {
      this.missing.unshift(parent); const next = dirname(parent);
      if (next === parent) throw new Error('Group state ancestry is unavailable'); parent = next;
    }
    this.parents.push(captureExistingDirectory(parent));
    for (const name of names) {
      if (!name || name.includes('/') || name.includes('\\')) throw new Error('Group state file name is unavailable');
      this.files.set(name, this.observe(name));
    }
    this.assertCurrent();
  }
  private observe(name: string): string | null { return fileStamp(lstatSync(join(this.directory, name), { bigint: true, throwIfNoEntry: false })); }
  assertCurrent(): void {
    for (const parent of this.parents) parent.assertCurrent();
    for (const path of this.missing) if (lstatSync(path, { throwIfNoEntry: false })) throw new Error('Group state parent appeared outside its original owner');
    for (const [name, stamp] of this.files) if (this.observe(name) !== stamp) throw new Error('Group state source changed outside its original owner');
  }
  ensure(): void {
    this.assertCurrent();
    while (this.missing.length > 0) {
      const path = this.missing[0]!; this.assertCurrent(); mkdirSync(path, { mode: 0o700 });
      const original = lstatSync(path, { bigint: true });
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.dev !== original.dev || opened.ino !== original.ino || !opened.isDirectory()) throw new Error('Created group state parent changed');
        fchmodSync(fd, 0o700);
        const current = lstatSync(path, { bigint: true });
        if (current.dev !== opened.dev || current.ino !== opened.ino || current.isSymbolicLink()) throw new Error('Created group state parent changed');
      } finally { closeSync(fd); }
      this.missing.shift(); this.parents.push(captureExistingDirectory(path)); this.assertCurrent();
    }
  }
  write(name: string, contents: string, durable: boolean): void {
    if (!this.files.has(name)) throw new Error('Group state file was not originally selected');
    this.ensure(); this.assertCurrent();
    let publication: string | null | undefined;
    writeFileAtomic(join(this.directory, name), contents, { mode: 0o600, durable, mkdirp: false, cleanupStaleTemps: false,
      assertCurrent: () => this.assertCurrent(),
      // This is provisional until the writer confirms its complete publication.
      // A failed durability check must not authorize another write from it.
      onEffect: published => { if (published) publication = this.observe(name); },
    });
    if (publication === undefined || publication === null || this.observe(name) !== publication) throw new Error('Original group state publication changed');
    this.files.set(name, publication);
    this.assertCurrent();
  }
}

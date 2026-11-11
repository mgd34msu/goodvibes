/** Inert interpreter feasibility only; this does not qualify application startup. */
import assert from 'node:assert/strict';
import { chmodSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdtempSync, openSync,
  readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

const [mode, library, provenance, output, ...extra] = process.argv.slice(2);
const result = {
  schema: 1, proof: 'darwin-sqlite-held-fd-loader-feasibility',
  qualification: 'inert-interpreter-only', mode: mode === 'positive' || mode === 'negative' ? mode : 'invalid',
  platform: process.platform, arch: process.arch, bunVersion: process.versions.bun ?? null,
  phase: 'admission', outcome: 'failed', loaderPathForm: 'at-executable-path-relative-dev-fd',
};
let root, fd;
const sameObject = (left, right) => left.dev === right.dev && left.ino === right.ino;
const heldRevision = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.mtimeNs, stat.birthtimeNs].join(':');
try {
  assert.equal(extra.length, 0);
  assert(mode === 'positive' || mode === 'negative');
  assert.equal(process.platform, 'darwin');
  assert(process.arch === 'x64' || process.arch === 'arm64');
  assert.equal(process.versions.bun, '1.3.14');
  assert.equal(basename(process.execPath), `goodvibes-daemon-macos-${process.arch}`);
  assert(isAbsolute(library) && isAbsolute(provenance) && isAbsolute(output));
  const originalLibrary = lstatSync(library), originalMetadata = lstatSync(provenance);
  assert(originalLibrary.isFile() && !originalLibrary.isSymbolicLink());
  assert(originalMetadata.isFile() && !originalMetadata.isSymbolicLink() && originalMetadata.size <= 16_384);
  const owner = JSON.parse(readFileSync(provenance, 'utf8'));
  assert.equal(owner.schema, 1);
  assert.equal(owner.packageName, '@goodvibes-jev/daemon');
  assert.equal(owner.target, `darwin-${process.arch}`);
  assert.equal(owner.sqliteVersion, '3.54.0');
  assert.equal(owner.size, originalLibrary.size);
  result.expectedSqliteVersion = owner.sqliteVersion;

  result.phase = 'api';
  const { Database } = await import('bun:sqlite');
  result.phase = 'fixture';
  root = mkdtempSync(join(realpathSync(tmpdir()), 'goodvibes-sqlite-fd-probe-'));
  chmodSync(root, 0o700);
  const selected = join(root, 'selected.dylib');
  const invalid = 'Inert invalid SQLite fixture. No executable foreign payload.\n';
  if (mode === 'positive') copyFileSync(library, selected, constants.COPYFILE_EXCL);
  else writeFileSync(selected, invalid, { flag: 'wx', mode: 0o600 });
  chmodSync(selected, 0o644);

  result.phase = 'descriptor';
  fd = openSync(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
  const original = fstatSync(fd, { bigint: true });
  assert(original.isFile());
  assert(sameObject(original, lstatSync(selected, { bigint: true })));
  const revision = heldRevision(original);
  const descriptorPath = `/dev/fd/${fd}`;
  try { result.fdPathReportsHeldObject = sameObject(original, statSync(descriptorPath, { bigint: true })); }
  catch { result.fdPathReportsHeldObject = false; }

  result.phase = 'named-path-replacement';
  // The open descriptor retains the original inode after unlink. The new
  // named file contains the opposite fixture; downloaded originals stay intact.
  unlinkSync(selected);
  if (mode === 'positive') writeFileSync(selected, invalid, { flag: 'wx', mode: 0o644 });
  else { copyFileSync(library, selected, constants.COPYFILE_EXCL); chmodSync(selected, 0o644); }
  result.namedPathReplaced = !sameObject(original, lstatSync(selected, { bigint: true }));
  result.heldObjectCurrent = heldRevision(fstatSync(fd, { bigint: true })) === revision;
  assert.equal(result.namedPathReplaced, true);
  assert.equal(result.heldObjectCurrent, true);

  result.phase = 'loader-selection';
  // Apple's dyld treats this original @ prefix differently from a plain
  // /dev/fd path on loader failure. Its suffix resolves relative to the actual
  // original compiled daemon executable, not the probe script or fixture.
  const loaderPath = `@executable_path/${relative(dirname(process.execPath), descriptorPath)}`;
  let selection;
  try {
    selection = Database.setCustomSQLite(loaderPath);
    result.selection = selection === true ? 'accepted' : selection === false ? 'refused' : 'unexpected-return';
  } catch {
    result.selection = 'threw';
  }
  result.heldObjectCurrent = heldRevision(fstatSync(fd, { bigint: true })) === revision;
  assert.equal(result.heldObjectCurrent, true);
  if (mode === 'negative') {
    // Pinned Bun throws synchronously on dlopen refusal; other explicit false
    // refusals are recorded too. Never construct a database after refusal.
    assert(result.selection === 'threw' || result.selection === 'refused');
    result.databaseConstructed = false;
    closeSync(fd); fd = undefined;
    result.outcome = 'refused';
  } else {
    assert.equal(selection, true);
    closeSync(fd); fd = undefined;
    result.descriptorClosedBeforeDatabase = true;
    result.phase = 'database-proof';
    const database = new Database(':memory:');
    result.databaseConstructed = true;
    try {
      const row = database.query('SELECT sqlite_version() AS version').get();
      assert.equal(row?.version, owner.sqliteVersion);
      result.selectedSqliteVersion = row.version;
    } finally { database.close(); }
    result.outcome = 'loaded-original';
  }
  result.phase = 'complete';
} catch {
  result.outcome = 'failed';
  process.exitCode = 1;
} finally {
  try {
    if (fd !== undefined) closeSync(fd);
    if (root !== undefined) rmSync(root, { recursive: true });
  } catch {
    result.phase = 'cleanup'; result.outcome = 'failed'; process.exitCode = 1;
  }
}
try {
  assert(typeof output === 'string' && isAbsolute(output));
  writeFileSync(output, JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
} catch {
  console.error('SQLite descriptor probe evidence could not be saved.');
  process.exitCode = 1;
}

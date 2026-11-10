/** Prepublication native lifecycle acceptance using the exact release artifact.
 * Only delivery changes: the source installer and installed programs execute
 * their ordinary commands against the original hosted account/service manager.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptPublishedSuite, readPublishedReaders } from './accept-published-suite.mjs';

const flatName = /^[A-Za-z0-9_.-]+$/;
const checksumName = 'SHA256SUMS.txt';
const repository = 'mgd34msu/goodvibes';
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const revision = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.uid, stat.mode].join(':');

/** Retain the exact catalog consumed by the real installer, old updater and
 * publisher. Those existing consumers verify downloaded bodies against this
 * manifest; catalog admission does not rehash their entire candidate. */
export async function admitStagedAssets(directory, signal) {
  const root = realpathSync(directory), original = lstatSync(root, { bigint: true });
  assert.ok(original.isDirectory() && !original.isSymbolicLink());
  const manifestPath = join(root, checksumName), manifestStat = lstatSync(manifestPath, { bigint: true });
  assert.ok(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.size <= 131072n);
  const manifest = readFileSync(manifestPath, 'utf8'), entries = new Map();
  for (const line of manifest.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    assert.ok(match && match[2] !== checksumName && !entries.has(match[2]), 'Invalid staged release checksum entry.');
    entries.set(match[2], {});
  }
  assert.ok(entries.size >= 64, 'The complete staged native suite is required.');
  const names = readdirSync(root);
  assert.equal(names.length, entries.size + 1);
  assert.ok(names.every(name => flatName.test(name) && (name === checksumName || entries.has(name))), 'Unexpected staged release member.');
  for (const [name, admitted] of entries) {
    signal?.throwIfAborted();
    const path = join(root, name), before = lstatSync(path, { bigint: true });
    assert.ok(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= 536870912n, 'Invalid staged release file.');
    admitted.path = path; admitted.revision = revision(before); admitted.size = Number(before.size);
  }
  assert.equal(revision(lstatSync(manifestPath, { bigint: true })), revision(manifestStat), 'Staged checksum manifest changed during admission.');
  entries.set(checksumName, { path: manifestPath, revision: revision(manifestStat), size: Number(manifestStat.size) });
  const assertCurrent = name => {
    assert.equal(revision(lstatSync(root, { bigint: true })), revision(original), 'Staged release directory changed.');
    const entry = entries.get(name); assert.ok(entry, 'Unadmitted staged release member.');
    assert.equal(revision(lstatSync(entry.path, { bigint: true })), entry.revision, 'Staged release member changed.');
    return entry;
  };
  return { root, entries, assertCurrent };
}

/** The real released updater accepts a configured custom feed. Serve only this
 * run's admitted candidate, without proxying requests or exposing credentials. */
export async function startStagedReleaseFeed(admitted, tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  let failure, closing;
  const activeStreams = new Set();
  const server = createServer((request, response) => {
    try {
      assert.ok(request.method === 'HEAD' || request.method === 'GET');
      if (request.url === '/releases/latest') {
        response.writeHead(302, { Location: `/releases/tag/${tag}`, 'Cache-Control': 'no-store' }); response.end(); return;
      }
      const prefix = `/releases/download/${tag}/`;
      assert.ok(request.url?.startsWith(prefix));
      const name = request.url.slice(prefix.length); assert.match(name, flatName);
      const entry = admitted.assertCurrent(name);
      response.writeHead(200, { 'Content-Length': entry.size, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      if (request.method === 'HEAD') { response.end(); return; }
      const stream = createReadStream(entry.path);
      const drained = new Promise(yes => stream.once('close', yes));
      activeStreams.add(drained); void drained.then(() => activeStreams.delete(drained));
      stream.on('error', error => { failure ??= error; response.destroy(); });
      stream.on('end', () => { try { admitted.assertCurrent(name); } catch (error) { failure ??= error; response.destroy(); } });
      response.on('close', () => stream.destroy()); stream.pipe(response);
    } catch (error) {
      failure ??= error;
      if (!response.headersSent) response.writeHead(404);
      response.end();
    }
  });
  server.requestTimeout = 180_000; server.headersTimeout = 15_000;
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}/releases/latest`,
    assertCurrent() { if (failure) throw failure; for (const name of admitted.entries.keys()) admitted.assertCurrent(name); },
    close() {
      closing ??= (async () => {
        await new Promise((yes, no) => { server.close(error => error ? no(error) : yes()); server.closeAllConnections(); });
        await Promise.all([...activeStreams]);
        if (failure) throw failure;
      })();
      return closing;
    },
  };
}

export async function acceptStagedSuite({ directory, ...input }) {
  let feed, admitted;
  const delivery = {
    rollbackSourceRoot: process.env.CANDIDATE_SOURCE_ROOT,
    installerSource: undefined,
    installerSourcePath: undefined,
    async admit({ tag, source, target, root, signal }) {
      admitted = await admitStagedAssets(directory, signal);
      const readers = await readPublishedReaders({ tag, source, target, assets: new Set(admitted.entries.keys()) }, async name => {
        const entry = admitted.assertCurrent(name); assert.ok(entry.size <= 131072);
        const value = JSON.parse(readFileSync(entry.path, 'utf8')); admitted.assertCurrent(name); return value;
      });
      // Read the immutable payload commit, even when current acceptance tooling
      // is running from a later commit. This never builds an installed program.
      const bytes = execFileSync('git', ['show', `${source}:scripts/install.sh`], { maxBuffer: 1_048_576 });
      delivery.installerSource = bytes.toString('utf8');
      const immutable = join(root, 'immutable-install.sh'); writeFileSync(immutable, bytes, { flag: 'wx', mode: 0o600 });
      delivery.installerSourcePath = immutable;
      const installer = join(root, 'install.sh');
      // The installer owns WORKDIR, verification, publication, service setup,
      // opt-out persistence and uninstall. Override only its existing fetch port.
      const base = `https://github.com/${repository}/releases/download/${tag}/`;
      const wrapper = `#!/bin/sh\nGOODVIBES_INSTALL_SH_LIB=1\n. ${shellQuote(immutable)}\nfetch() {\n  case "$1" in ${shellQuote(base)}*) staged_name=\${1#${shellQuote(base)}} ;; *) fail 'Unadmitted staged release URL' ;; esac\n  case "$staged_name" in ''|*[!A-Za-z0-9_.-]*) fail 'Invalid staged release asset' ;; esac\n  [ ! -f "$2" ] || return 0\n  cp ${shellQuote(admitted.root)}/"$staged_name" "$2"\n}\nmain "$@"\n`;
      writeFileSync(installer, wrapper, { flag: 'wx', mode: 0o600 });
      if (input.scenario === 'upgrade-v3.1.1') feed = await startStagedReleaseFeed(admitted, tag);
      return { readers, installer, published: { url: `git:${source}:scripts/install.sh`, bytes } };
    },
    assertCurrent() {
      assert.ok(admitted); for (const name of admitted.entries.keys()) admitted.assertCurrent(name);
      feed?.assertCurrent();
    },
    async finish() { await feed?.close(); },
    async preparePrevious({ invoke, daemon, setting }) {
      assert.ok(feed); feed.assertCurrent();
      await invoke(daemon, ['config', 'set', 'update.releasesUrl', feed.url]);
      assert.equal(await setting('update.releasesUrl'), feed.url);
    },
  };
  let failure;
  try { await acceptPublishedSuite({ ...input, delivery }); }
  catch (error) { failure = error; }
  finally {
    try { await feed?.close(); }
    catch (error) { if (failure !== error) failure = failure ? new AggregateError([failure, error], 'Staged acceptance and feed cleanup failed.') : error; }
  }
  if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, source, target, directory, scenario = 'fresh'] = process.argv.slice(2);
  const controller = new AbortController(), stop = () => controller.abort(new Error('Staged acceptance owner stopped.'));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  acceptStagedSuite({ tag, source, target, directory, scenario, signal: controller.signal })
    .catch(() => { console.error('Staged native acceptance failed; publication must remain blocked.'); process.exitCode = 1; })
    .finally(() => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); });
}

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { captureExistingDirectory } from '@goodvibes-jev/engine/platform/platform/state/durable-file-io';
import { LegacyImportJournal, type LegacyImportJournalOptions } from './legacy-work-ledger-import-journal.js';

function historicalCandidates(directory: string) {
  let revision: string | undefined, present = false;
  let original: ReturnType<typeof captureExistingDirectory> | undefined;
  return () => {
    const stat = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    if (!stat) { if (original) throw new Error('Original import journal namespace disappeared'); return false; }
    if (original) original.assertCurrent(); else original = captureExistingDirectory(directory);
    // Inspect actual entry names only when this directory changes. New native
    // slots never derive filenames from a digest or scan all journal bodies.
    const actual = lstatSync(original.canonical, { bigint: true });
    const next = [actual.dev, actual.ino, actual.birthtimeNs, actual.mtimeNs, actual.ctimeNs].join(':');
    if (next !== revision) { present = readdirSync(directory).some(name => /^[0-9a-f]{64}\.sqlite$/.test(name)); original.assertCurrent(); revision = next; }
    return present;
  };
}
const originalFile = (path: string): string => {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Original import journal is not a regular owned file');
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');
};
/** Agent and TUI share one SQLite journal keyed on exact private workspace/project
 * tuples. Only an actually present historical filename invokes its old recipe;
 * fresh selections need no digest, registry or new random assignment.
 */
export function resolveLegacyImportJournalLocation(input: { workspace: string; projectId: string; stateDirectory: string }) {
  if (!input.projectId.trim() || input.projectId.length > 200) throw new Error('Project identity required');
  const projectId = input.projectId, workspacePath = input.workspace, workspace = realpathSync(workspacePath), directory = resolve(input.stateDirectory);
  let ancestor = directory;
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) { const parent = dirname(ancestor); if (parent === ancestor) throw new Error('Import state parent unavailable'); ancestor = parent; }
  const owner = captureExistingDirectory(ancestor), selected = captureExistingDirectory(workspacePath);
  const current = () => { owner.assertCurrent(); selected.assertCurrent(); if (realpathSync(workspacePath) !== workspace) throw new Error('Original import workspace changed'); };
  const agent = join(directory, 'agent', 'legacy-import'), shared = join(directory, 'shared', 'legacy-import'), fixed = join(shared, 'journal.sqlite');
  const agentCandidates = historicalCandidates(agent), sharedCandidates = historicalCandidates(shared);
  let oldKey: string | undefined;
  const historical = (): string | null => {
    current(); const oldAgent = agentCandidates(), oldShared = sharedCandidates(); if (!oldAgent && !oldShared) return null;
    // Compatibility with real saved hash-named journals only. The exact saved
    // binding/command is still independently parsed by the original SQLite owner.
    oldKey ??= createHash('sha256').update(JSON.stringify([workspace, projectId])).digest('hex');
    if (lstatSync(join(agent, `${oldKey}.sqlite`), { throwIfNoEntry: false })) throw new Error('An earlier Agent import journal exists; reconcile its exact saved request before selecting the shared journal');
    const path = join(shared, `${oldKey}.sqlite`);
    if (!lstatSync(path, { throwIfNoEntry: false })) return null;
    if (lstatSync(fixed, { throwIfNoEntry: false })) {
      const journal = new LegacyImportJournal(fixed, undefined, { layout: 'shared-v2', assertCurrent: current });
      try { if (journal.hasScope(workspace, projectId)) throw new Error('Both historical and shared import journals contain this scope; preserve both saved requests and reconcile their original outcomes'); }
      finally { journal.close(); }
    }
    return path;
  };
  const path = historical(); current();
  if (path) {
    const parent = captureExistingDirectory(shared), stamp = originalFile(path);
    return { workspace, journalPath: path, layout: 'historical-v1' as const, assertCurrent() { current(); parent.assertCurrent(); if (originalFile(path) !== stamp || historical() !== path) throw new Error('Original import journal changed'); } };
  }
  let fixedStamp = lstatSync(fixed, { throwIfNoEntry: false }) ? originalFile(fixed) : undefined;
  return { workspace, journalPath: fixed, layout: 'shared-v2' as const, assertCurrent() {
    current(); if (historical() !== null) throw new Error('A historical import journal appeared; preserve the current request and inspect both original journals');
    if (fixedStamp !== undefined) { if (originalFile(fixed) !== fixedStamp) throw new Error('Original shared import journal changed'); }
    else if (lstatSync(fixed, { throwIfNoEntry: false })) fixedStamp = originalFile(fixed);
  } };
}

/** Actual product roots supply their live context reads; one platform owner
 * captures the original configuration/writer before any authentication await.
 */
export function retainLegacyImportJournalOwner(location: ReturnType<typeof resolveLegacyImportJournalLocation>, config: Pick<ConfigManager, 'getNativeDataWriter'>,
  stateDirectory: string, current: () => { readonly config: object; readonly stateDirectory: string }): LegacyImportJournalOptions {
  const nativeWriter = config.getNativeDataWriter?.();
  const assertCurrent = () => {
    location.assertCurrent(); const selected: unknown = current();
    if (nodeTypes.isPromise(selected)) { drainOwned(selected); throw new Error('Import journal selection must complete synchronously'); }
    if (!selected || typeof selected !== 'object') throw new Error('Original import state selection changed');
    const owner = Object.getOwnPropertyDescriptor(selected, 'config'), directory = Object.getOwnPropertyDescriptor(selected, 'stateDirectory');
    if (!owner || !('value' in owner) || owner.value !== config || !directory || !('value' in directory) || directory.value !== stateDirectory) throw new Error('Original import state selection changed');
    location.assertCurrent();
  };
  assertCurrent();
  return { layout: location.layout, beforeWrite: () => nativeWriter?.declare('terminal-import-journals-v2'),
    beforeManifestWrite: version => { if (version === 3) nativeWriter?.declare('native-historical-import-revisions-v3'); }, assertCurrent };
}

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { LegacyImportJournal, type LegacyImportJournalOptions } from './legacy-work-ledger-import-journal.js';

const hasHistoricalJournals = (directory: string): boolean => {
  try { return readdirSync(directory).some(name => /^[0-9a-f]{64}\.sqlite$/.test(name)); } catch { return false; }
};
export interface LegacyImportJournalLocation {
  readonly workspace: string;
  readonly journalPath: string;
  readonly layout: 'historical-v1' | 'shared-v2';
}
/**
 * Agent and TUI share one SQLite journal keyed on the workspace and project.
 * A journal saved under the older hash-named layout is used where it exists,
 * so its saved request is never lost; the choice is made once per command.
 */
export function resolveLegacyImportJournalLocation(input: { workspace: string; projectId: string; stateDirectory: string }): LegacyImportJournalLocation {
  if (!input.projectId.trim() || input.projectId.length > 200) throw new Error('Project identity required');
  const projectId = input.projectId, workspace = realpathSync(input.workspace), directory = resolve(input.stateDirectory);
  const agent = join(directory, 'agent', 'legacy-import'), shared = join(directory, 'shared', 'legacy-import'), fixed = join(shared, 'journal.sqlite');
  if (hasHistoricalJournals(agent) || hasHistoricalJournals(shared)) {
    const oldKey = createHash('sha256').update(JSON.stringify([workspace, projectId])).digest('hex');
    if (lstatSync(join(agent, `${oldKey}.sqlite`), { throwIfNoEntry: false })) throw new Error('An earlier Agent import journal exists; reconcile its exact saved request before selecting the shared journal');
    const path = join(shared, `${oldKey}.sqlite`);
    if (lstatSync(path, { throwIfNoEntry: false })) {
      if (lstatSync(fixed, { throwIfNoEntry: false })) {
        const journal = new LegacyImportJournal(fixed, undefined, { layout: 'shared-v2' });
        try { if (journal.hasScope(workspace, projectId)) throw new Error('Both historical and shared import journals contain this scope; preserve both saved requests and reconcile their original outcomes'); }
        finally { journal.close(); }
      }
      return { workspace, journalPath: path, layout: 'historical-v1' };
    }
  }
  return { workspace, journalPath: fixed, layout: 'shared-v2' };
}

/**
 * The journal's format declarations for the installed native writer. The two
 * trailing arguments are accepted from older callers and not used.
 */
export function retainLegacyImportJournalOwner(location: LegacyImportJournalLocation, config: Pick<ConfigManager, 'getNativeDataWriter'>,
  ..._unused: readonly unknown[]): LegacyImportJournalOptions {
  const nativeWriter = config.getNativeDataWriter?.();
  return { layout: location.layout, beforeWrite: () => nativeWriter?.declare('terminal-import-journals-v2'),
    beforeManifestWrite: version => version === 3 ? nativeWriter?.declare('native-historical-import-revisions-v3') : undefined };
}

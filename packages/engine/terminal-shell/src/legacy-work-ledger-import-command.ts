import type { LegacyImportOperatorSession } from './legacy-work-ledger-import-operator.js';
import type { LegacyImportEntry } from './legacy-work-ledger-import-journal.js';
import { legacyMigrationPreparationRevision, projectLegacyImportWorks } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger';
import { commandRefusal } from './command-confirmation.js';

const quote = (value: string): string => JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** What `/work` does with the saved legacy import of one project. */
export type LegacyImportStep = 'preview' | 'status' | 'submit' | 'reconsider' | 'recover' | 'cancel' | 'restart';

/** The saved import's state and the one line that moves it on. */
function entryLines(entry: LegacyImportEntry | null, project: string): string[] {
  if (!entry) return ['No saved import of old planning records for this project.', `Next: /work import-preview ${project}, then /work import ${project}.`];
  const lines = [`Import status: ${entry.state}`, `Request: ${quote(entry.command.requestId)}`, `Dispatch attempts: ${entry.attempts}`, `Preparation revision: ${legacyMigrationPreparationRevision(entry.command.manifest)}`];
  for (const decision of entry.decisions) lines.push(`Recorded Jev outcome: ${decision.outcome}; decision ${quote(decision.decisionId)}`);
  if (entry.result?.kind === 'rejected') lines.push(`Host rejection: ${entry.result.code}: ${quote(entry.result.reason)}`);
  if (entry.state === 'accepted') lines.push('Imported as historical work records. The old sources stay in place and no work was started.');
  if (entry.state === 'unknown') lines.push(`The host's answer did not arrive. Next: /work import-recover ${project} resends the same request, which the host applies once.`);
  if (entry.state === 'pending') lines.push(`The host has not admitted it yet. Next: /work import-reconsider ${project} asks again, or /work import-cancel ${project} drops it.`);
  if (entry.state === 'cancelled' || entry.state === 'rejected') lines.push(`Next: /work import-restart ${project} prepares a fresh import; this one stays in the history.`);
  return lines;
}

/**
 * One step of importing old planning records into the native work ledger, with
 * safe retry of a lost request. The host decides whether an import is
 * admitted; nothing on the line can authorize one. Returns the lines to print.
 */
export async function runLegacyImportStep<T>(
  step: LegacyImportStep,
  project: string,
  requestId: string,
  context: T & { print(text: string): void },
  open: (context: T, projectId: string) => Promise<LegacyImportOperatorSession>,
): Promise<string> {
  let session: LegacyImportOperatorSession | undefined;
  try {
    session = await open(context, project);
    const binding = session.binding;
    const lines = [`Project: ${quote(binding.projectId)}`, `Endpoint: ${quote(binding.endpoint)}`,
      `Principal: ${quote(binding.principalKind)}:${quote(binding.principalId)}`, `Workspace: ${quote(binding.workspaceId)}`];
    if (step === 'preview') {
      const prepared = await session.prepare();
      if (prepared.kind === 'blocked') lines.unshift(`The host blocked the preparation: ${prepared.code}: ${quote(prepared.reason)}`, `Next: resolve that on the host, then run /work import-preview ${project} again.`);
      else {
        const manifest = prepared.manifest;
        lines.unshift('Import preview', `Preparation revision: ${legacyMigrationPreparationRevision(manifest)}`, `Expected ledger revision: ${manifest.expectedLedgerRevision}`);
        lines.push(`Complete sources: ${manifest.sources.length}`);
        for (const source of manifest.sources) lines.push(`Source: ${quote(String(source.source.id))}`, `  Generation: ${source.generation}`);
        for (const work of projectLegacyImportWorks(manifest, 0)) {
          lines.push(`Work: ${quote(work.id)} ${quote(work.title)}; reported=${work.reportedState}`, `  Goal: ${quote(work.goal)}`);
          for (const criterion of work.criteria) lines.push(`  Criterion: ${quote(criterion)}`);
        }
        for (const link of manifest.links) lines.push(`Link: ${quote(link.from)} ${quote(link.relation)} ${quote(link.to)}`);
        lines.push(`Next: /work import ${project} imports this.`);
      }
    } else {
      if (step !== 'status' && step !== 'cancel') context.print('Import request pending. Waiting for the host to admit it.');
      const id = requestId || undefined;
      const entry = step === 'status' ? await session.status() : step === 'submit' ? await session.submit() : await session[step](id);
      lines.unshift(...entryLines(entry, project));
      if (step === 'cancel' && entry?.state !== 'cancelled') lines.unshift(`Nothing was cancelled: cancel applies only to a pending import, and this one is ${entry?.state ?? 'not saved'}.`);
    }
    return lines.join('\n');
  } catch (error) {
    const read = step === 'preview' || step === 'status';
    throw commandRefusal(`The import ${read ? 'could not be read' : 'step did not run'}: ${quote(error instanceof Error ? error.message : String(error))}${read ? '' : `\nA request already sent stays saved with its id; /work import-status ${project} says the next step.`}`);
  } finally { session?.dispose(); }
}

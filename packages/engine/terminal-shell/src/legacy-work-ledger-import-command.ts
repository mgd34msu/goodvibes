import type { LegacyImportOperatorSession } from './legacy-work-ledger-import-operator.js';
import type { LegacyImportEntry } from './legacy-work-ledger-import-journal.js';
import { legacyMigrationPreparationRevision, projectLegacyImportWorks } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandEffect } from './command-registry.js';
interface Context { print(text: string): void }
interface Registry<T extends Context> { register(command: { name: string; effect: TerminalCommandEffect; description: string; usage: string; argsHint: string; handler(args: string[], context: T): Promise<void> }): void }
const quote = (value: string): string => JSON.stringify(value).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
const usage = 'preview|status|submit <project-id> | reconsider|recover|cancel|restart <project-id> [request-id]';
/** The saved import's state and the one command that moves it on. */
function entryLines(entry: LegacyImportEntry | null, project: string): string[] {
  if (!entry) return ['No saved legacy import for selected project.', `Next: /work-import preview ${project}, then /work-import submit ${project}.`];
  const lines = [`Legacy import status: ${entry.state}`, `Request: ${quote(entry.command.requestId)}`, `Dispatch attempts: ${entry.attempts}`, `Preparation revision: ${legacyMigrationPreparationRevision(entry.command.manifest)}`];
  for (const decision of entry.decisions) lines.push(`Recorded Jev outcome: ${decision.outcome}; decision ${quote(decision.decisionId)}`);
  if (entry.result?.kind === 'rejected') lines.push(`Host rejection: ${entry.result.code}: ${quote(entry.result.reason)}`);
  if (entry.state === 'accepted') lines.push('Imported as historical work records. The legacy sources stay in place and no work was started.');
  if (entry.state === 'unknown') lines.push(`The host's answer did not arrive. Next: /work-import recover ${project} resends the same request, which the host applies once.`);
  if (entry.state === 'pending') lines.push(`The host has not admitted it yet. Next: /work-import reconsider ${project} asks again, or /work-import cancel ${project} drops it.`);
  if (entry.state === 'cancelled' || entry.state === 'rejected') lines.push(`Next: /work-import restart ${project} prepares a fresh import; this one stays in the history.`);
  return lines;
}
/** Keyboard and model callers share deterministic authorization and host-owned Jev admission. */
export function registerLegacyImportCommands<T extends Context>(registry: Registry<T>, open: (context: T, projectId: string) => Promise<LegacyImportOperatorSession>): void {
  registry.register({ name: 'work-import', effect: 'mixed', description: 'Import legacy planning records into the native work ledger, with safe retry of a lost request', usage, argsHint: usage,
    async handler(args, context) {
      const action = args[0];
      const initial = action === 'preview' || action === 'status' || action === 'submit';
      const retained = action === 'reconsider' || action === 'recover' || action === 'cancel' || action === 'restart';
      if ((!initial && !retained) || args.length < 2 || args.length > (initial ? 2 : 3) || args.slice(1).some(arg => !arg.trim() || arg.startsWith('--'))) { throw commandRefusal(`Usage: /work-import ${usage}. The host decides whether an import is admitted; payload flags cannot authorize an import.`); }
      const project = args[1]!;
      let session: LegacyImportOperatorSession | undefined;
      try {
        session = await open(context, project);
        const binding = session.binding;
        const lines = [`Project: ${quote(binding.projectId)}`, `Endpoint: ${quote(binding.endpoint)}`,
          `Principal: ${quote(binding.principalKind)}:${quote(binding.principalId)}`, `Workspace: ${quote(binding.workspaceId)}`];
        if (action === 'preview') {
          const prepared = await session.prepare();
          if (prepared.kind === 'blocked') lines.unshift(`The host blocked the preparation: ${prepared.code}: ${quote(prepared.reason)}`, `Next: resolve that on the host, then run /work-import preview ${project} again.`);
          else {
            const manifest = prepared.manifest;
            lines.unshift('Legacy import preview', `Preparation revision: ${legacyMigrationPreparationRevision(manifest)}`, `Expected ledger revision: ${manifest.expectedLedgerRevision}`);
            lines.push(`Complete sources: ${manifest.sources.length}`);
            for (const source of manifest.sources) lines.push(`Source: ${quote(String(source.source.id))}`, `  Generation: ${source.generation}`);
            for (const work of projectLegacyImportWorks(manifest, 0)) {
              lines.push(`Work: ${quote(work.id)} ${quote(work.title)}; reported=${work.reportedState}`, `  Goal: ${quote(work.goal)}`);
              for (const criterion of work.criteria) lines.push(`  Criterion: ${quote(criterion)}`);
            }
            for (const link of manifest.links) lines.push(`Link: ${quote(link.from)} ${quote(link.relation)} ${quote(link.to)}`);
            lines.push(`Next: /work-import submit ${project} imports this.`);
          }
        } else {
          const requestId = args[2];
          if (action !== 'status' && action !== 'cancel') context.print('Legacy import request pending. Waiting for the host to admit it.');
          const entry = action === 'status' ? await session.status() : action === 'submit' ? await session.submit() : await session[action! as 'reconsider' | 'recover' | 'cancel' | 'restart'](requestId);
          lines.unshift(...entryLines(entry, project));
          if (action === 'cancel' && entry?.state !== 'cancelled') lines.unshift(`Nothing was cancelled: cancel applies only to a pending import, and this one is ${entry?.state ?? 'not saved'}.`);
        }
        context.print(lines.join('\n'));
      } catch (error) {
        throw commandRefusal(`Legacy import ${initial && action !== 'submit' ? 'read' : 'operation'} unavailable: ${quote(error instanceof Error ? error.message : String(error))}${action === 'preview' || action === 'status' ? '' : `\nA request already sent stays saved with its id; run /work-import status ${project} for the next step.`}`);
      } finally { session?.dispose(); }
    } });
}

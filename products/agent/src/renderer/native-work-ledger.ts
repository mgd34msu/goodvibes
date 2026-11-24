import { legacyMigrationPreparationRevision } from '@goodvibes/engine/platform/platform/workflow/work-ledger';
import { nativeWorkExecutionLines } from '@goodvibes/engine/terminal-shell/native';
import type { NativeWorkLedgerState } from '../runtime/native-work-ledger.ts';

/** Plain terminal text only; ledger content never becomes an action or terminal escape. */
const safe = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
/** The same scrub for values typed as enums or numbers: a ledger read from disk or the daemon is not trusted to honour the type. */
const plain = (value: unknown): string => safe(String(value));
export function nativeWorkLedgerLines(state: NativeWorkLedgerState): string[] {
  const lines = ['Work recorded on the host · it runs only when you start it'];
  if (state.status !== 'ready') return [...lines, `${plain(state.status)}: ${safe(state.reason)}`];
  lines.push(`Project ${safe(state.snapshot.projectId)} · snapshot ${plain(state.snapshot.cursor)} · history ${plain(state.cursor)}`);
  if (state.reason) lines.push(`Showing the last rows read: ${safe(state.reason)}`);
  if (!state.snapshot.works.length) lines.push('No native work recorded for this project.');
  for (const view of state.snapshot.works) {
    const { work, attempt, verification } = view;
    lines.push(`Work ${safe(work.id)} · revision ${plain(work.revision)} · ${safe(work.title)}`,
      `Intent: ${safe(work.goal)}`,
      `Reported: ${plain(work.reportedState)} · Verification: ${plain(verification.state)}`,
      `Verification reason: ${safe(verification.reason)}`,
      `Criteria revision ${plain(work.criteriaRevision)}`);
    work.criteria.forEach((criterion, index) => lines.push(`  ${plain(index + 1)}. ${safe(criterion)}`));
    lines.push(attempt ? `Attempt ${safe(attempt.id)} · revision ${plain(attempt.revision)} · owner ${safe(attempt.ownerId)} · ${plain(attempt.state)}` : 'Attempt: none');
    if (attempt?.predecessorId) lines.push(`Previous attempt: ${safe(attempt.predecessorId)}`);
    if (attempt?.report) lines.push(`Report: ${safe(attempt.report)}`);
    if (attempt?.blocker) lines.push(`Blocker: ${safe(attempt.blocker)}`);
    for (const attention of view.attention) lines.push(`Attention (${plain(attention.kind)}): ${safe(attention.reason)}`);
    const evidence = verification.evidence;
    if (!evidence) lines.push('Evidence: none');
    else {
      lines.push(`Evidence ${safe(evidence.id)} · ${plain(evidence.outcome)} · ${plain(evidence.source)} · actor ${safe(evidence.actorId)}`,
        `Target ${safe(evidence.target.workId)} r${plain(evidence.target.workRevision)} · criteria r${plain(evidence.target.criteriaRevision)} · attempt ${safe(evidence.target.attemptId)} r${plain(evidence.target.attemptRevision)}`);
      for (const ref of evidence.references) lines.push(`  ${plain(ref.kind)}: ${safe(ref.ref)}${ref.digest ? ` · digest ${safe(ref.digest)}` : ''}`);
      for (const result of evidence.criteriaResults) lines.push(`  Criterion ${plain(result.criterionIndex + 1)}: ${plain(result.status)} · ${result.references.map(safe).join(', ')}`);
    }
  }
  for (const line of nativeWorkExecutionLines(state.execution)) lines.push(safe(line));
  lines.push('To act on one: /work start, /work status, /work cancel or /work resume with its id. Nothing resumes on its own; closing this only stops watching.');
  lines.push('History (read only: nothing here starts anything)');
  const earlier = state.earlierEvents ?? 0;
  if (earlier > 0) lines.push(`${plain(earlier)} earlier events are not shown; the newest ${plain(state.history.length)} follow.`);
  for (const event of state.history) {
    if (event.type === 'import_legacy') {
      lines.push(`#${plain(event.sequence)} import_legacy · ${plain(event.works.length)} work records · ${event.manifest ? `${plain(event.manifest.sources.length)} preserved sources` : 'protected source provenance'}`,
        `  Actor ${safe(event.actorId)} · request ${safe(event.requestId)}`);
      for (const work of event.works) lines.push(`  Work ${safe(work.id)} r${plain(work.revision)} · ${safe(work.title)} · reported ${plain(work.reportedState)} · imported unverified`);
      if (!event.manifest) { lines.push('  Where this came from is hidden: showing it needs permission to read knowledge.'); continue; }
      lines.push(`  Imported from earlier records (${safe(legacyMigrationPreparationRevision(event.manifest))}) · an old approval does not start anything`);
      for (const entity of event.manifest.entities) {
        lines.push(`  Legacy ${plain(entity.kind)} ${safe(entity.id)} · ${plain(entity.fragments.length)} source fragments`);
        for (const fragment of entity.fragments) lines.push(`    Source ${safe(fragment.sourceId)} ${safe(fragment.pointer)}`);
      }
      for (const source of event.manifest.sources) lines.push(`  Preserved source ${safe(String(source.source.id))} · generation ${safe(source.generation)} · ${safe(JSON.stringify(source.source))}`);
      for (const link of event.manifest.links) lines.push(`  Link ${safe(link.from)} · ${safe(link.relation)} · ${safe(link.to)}`);
      continue;
    }
    lines.push(`#${plain(event.sequence)} ${plain(event.type)} · work ${safe(event.workId)} r${plain(event.work.revision)} · criteria r${plain(event.work.criteriaRevision)} · attempt ${safe(event.attemptId ?? 'none')}`);
    lines.push(`  Actor ${safe(event.actorId)} · request ${safe(event.requestId)} · reported ${plain(event.work.reportedState)}`,
      `  Intent: ${safe(event.work.goal)}`);
    event.work.criteria.forEach((criterion, index) => lines.push(`  Criterion ${plain(index + 1)}: ${safe(criterion)}`));
    for (const attempt of event.attempts) {
      lines.push(`  Attempt ${safe(attempt.id)} r${plain(attempt.revision)} · ${plain(attempt.state)} · owner ${safe(attempt.ownerId)} · previous ${safe(attempt.predecessorId ?? 'none')}`);
      if (attempt.report) lines.push(`  Report: ${safe(attempt.report)}`);
      if (attempt.blocker) lines.push(`  Blocker: ${safe(attempt.blocker)}`);
    }
    if (event.reason) lines.push(`  ${safe(event.reason)}`);
    if (event.evidence) for (const ref of event.evidence.references) lines.push(`  ${plain(ref.kind)}: ${safe(ref.ref)}`);
  }
  return lines;
}

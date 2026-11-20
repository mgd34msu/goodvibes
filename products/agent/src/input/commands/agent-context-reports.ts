/**
 * The Agent's own reports for facts that used to show only in its workspace:
 * the project instruction files read into each turn (`/context files`), what
 * the last turns were given (`/context given`), and the commands running in
 * the background (`/tasks processes`). Each reads this machine only.
 */
import { discoverProjectContextFiles } from '@goodvibes-jev/engine/terminal-shell/agent-turn/project-context-files';
import type { CommandContext } from '../command-registry.ts';
import { buildProcessSupervisionSummary, buildPromptContextReceiptTimeline } from '../agent-workspace-context-snapshot.ts';
import { requireShellPaths } from './runtime-services.ts';

export function instructionFilesReport(ctx: CommandContext): string {
  const found = discoverProjectContextFiles(requireShellPaths(ctx));
  if (found.files.length === 0 && found.blocked.length === 0) {
    return 'No project instruction files are read here. AGENTS.md, CLAUDE.md, HERMES.md, SOUL.md and Cursor rules in this project or your home are read when present.';
  }
  return [
    `Project instruction files read into each turn (${found.files.length})`,
    ...found.files.map((file) => `  ${file.path}${file.truncated ? '  (cut short)' : ''}`),
    ...(found.blocked.length > 0 ? ['', `Held back (${found.blocked.length})`, ...found.blocked.map((file) => `  ${file.path}: ${file.reason}`)] : []),
  ].join('\n');
}

export function lastTurnsReport(ctx: CommandContext): string {
  const timeline = buildPromptContextReceiptTimeline(ctx);
  if (timeline.status === 'unavailable') return 'What each turn was given is not recorded in this session.';
  if (timeline.items.length === 0) return 'No turn has run yet; after one, this shows what it was given.';
  return [
    `What the last turns were given (${timeline.items.length} of ${timeline.count})`,
    ...timeline.items.map((item) => `  ${new Date(item.createdAt).toISOString().slice(0, 16).replace('T', ' ')}  ${item.model}: ${item.activeRecords} given, ${item.suppressedRecords} left out, about ${item.approxPromptTokens.toLocaleString()} tokens, ${item.outcomeStatus}`),
  ].join('\n');
}

export function backgroundCommandsReport(ctx: CommandContext): string {
  const summary = buildProcessSupervisionSummary(ctx);
  if (summary.status === 'unavailable') return 'Background commands are not available in this session.';
  return [
    summary.tracked === 0 ? 'No commands are running in the background.' : `Background commands: ${summary.running} running, ${summary.completed} finished.`,
    `A running one ${summary.stdinWriteStatus === 'supported-with-confirmation' ? 'can be given input, after you confirm' : 'cannot be given input'}; ${summary.ptyStatus === 'contract-discovered' ? 'one can run in a terminal' : 'none runs in a terminal'}; sudo runs only in the foreground.`,
    'F2 opens the process monitor, where you can follow or stop each.',
  ].join('\n');
}

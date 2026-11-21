import { commandJsonOrText as jsonOrText } from '@goodvibes/engine/terminal-shell/cli-output';
import { commandArgsWithLiteralMarker } from '@goodvibes/engine/terminal-shell/cli-parser-engine';
import type {
  AttemptCandidate,
  AttemptJudgment,
  AttemptPickResult,
  HeldMergeGroup,
} from '@goodvibes/engine/platform/platform/orchestration';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { formatUsd } from '@goodvibes/engine/terminal-shell/format';
import { operatorFlagValue, parseOperatorCommandArgs } from './operator-command-args.ts';
import { createAgentDaemonVerbCaller, ConnectedHostVerbError, DaemonVerbNotSentError, isDefiniteHostRefusal } from '../runtime/client/daemon-verbs.ts';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';

/**
 * Best-of-N groups live in the contract runner that runs their contract. A
 * one-shot command runs none, so it asks the connected host's runner through
 * the `fleet.attempts.*` verbs; it never starts a runner of its own (that would
 * take up another process's contracts and show groups only by racing it).
 * Groups held by contracts an open Agent is running are reviewed from that
 * Agent.
 */

const FLEET_ATTEMPTS_PICK_USAGE = 'Usage: goodvibes-agent fleet attempts pick <groupId> <winnerItemId> --yes';
const FLEET_ATTEMPTS_JUDGE_USAGE = 'Usage: goodvibes-agent fleet attempts judge <groupId>';
const FLEET_USAGE =
  'Usage: goodvibes-agent fleet attempts [list [--workstream <workstreamId>]|pick <groupId> <winnerItemId> --yes|judge <groupId>]';

function usageFailure(runtime: CliCommandRuntime, error: string): CliCommandOutput {
  return {
    output: jsonOrText(runtime, { ok: false, kind: 'invalid_fleet_command', error }, error),
    exitCode: 2,
  };
}

const HOST_NEXT = 'Start the GoodVibes daemon (goodvibes-daemon) or check controlPlane.host and controlPlane.port; groups held by an open Agent are reviewed in that Agent.';

/** Error codes of a connection that was never made, so no request reached the host. */
const NOT_CONNECTED_CODES = new Set(['ECONNREFUSED', 'ConnectionRefused', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'FailedToOpenSocket']);

/** Whether the call failed before any request reached the host: no connection could be resolved, or the host refused the connection. */
function neverReachedHost(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof ConnectedHostVerbError || error.name === 'TimeoutError') return false;
  if (error instanceof DaemonVerbNotSentError) return true;
  const code = (error as { readonly code?: unknown }).code ?? (error.cause as { readonly code?: unknown } | undefined)?.code;
  return typeof code === 'string' && NOT_CONNECTED_CODES.has(code);
}

/**
 * The failure of one `fleet attempts` call. A host refusal (a 4xx) and a call
 * that never reached the host are definite; anything else (a timeout, a 5xx, a
 * dropped connection) leaves it unknown whether the host acted, which for a pick
 * means the winner may already be merged.
 */
function errorFailure(runtime: CliCommandRuntime, error: unknown, action: 'list' | 'pick' | 'judge'): CliCommandOutput {
  const message = summarizeError(error);
  const status = error instanceof ConnectedHostVerbError ? error.status : undefined;
  const unavailable = neverReachedHost(error);
  const unknownOutcome = !unavailable && !isDefiniteHostRefusal(error);
  const kind = unavailable ? 'connected_host_unavailable'
    : unknownOutcome ? (action === 'pick' ? 'fleet_attempts_outcome_unknown' : 'fleet_attempts_error')
      : status === 404 ? 'connected_host_incompatible' : 'fleet_attempts_error';
  const next = unavailable ? HOST_NEXT
    : unknownOutcome
      ? (action === 'pick'
        ? 'Run fleet attempts list: a group that is no longer listed was picked; one still listed can be picked again.'
        : 'The host did not answer this call cleanly; retry it, and read the daemon log if it keeps failing.')
      : status === 404 ? 'The connected host does not run best-of-N contracts; update GoodVibes on the host.'
        : status === 409 ? 'List the groups again (fleet attempts list) and use an id it shows.'
          : undefined;
  return {
    output: jsonOrText(runtime, { ok: false, kind, error: message, ...(status === undefined ? {} : { status }), ...(next ? { next: [next] } : {}) },
      next ? `${message}\n  next ${next}` : message),
    exitCode: 1,
  };
}

function hostVerbs(runtime: CliCommandRuntime) {
  return createAgentDaemonVerbCaller({ configManager: runtime.configManager, homeDirectory: runtime.homeDirectory, invokeTimeoutMs: 30_000 });
}

/** The model proposal is clearly labeled at every point it renders, never presented as a decision. */
function renderJudgment(judgment: AttemptJudgment | null): readonly string[] {
  if (!judgment) return ['    judge proposal: none yet'];
  const winner = judgment.proposedWinnerItemId ?? '(judge declined to choose)';
  const lines = [
    `    MODEL PROPOSAL (scored by ${judgment.model ?? 'unknown model'}, not a decision, confirm with fleet attempts pick)`,
    `      proposed winner ${winner}`,
  ];
  for (const reason of judgment.reasons) lines.push(`      reason: ${reason}`);
  return lines;
}

function renderCandidate(candidate: AttemptCandidate): readonly string[] {
  const lines = [`    ${candidate.itemId}  attempt #${candidate.attemptIndex}  ${candidate.state}  ${candidate.title}`];
  if (candidate.state === 'failed' && candidate.failureReason) {
    lines.push(`      failure: ${candidate.failureReason}`);
  }
  if (candidate.diff) {
    lines.push(`      diff: ${candidate.diff.files.length} file(s), ${candidate.diff.stat}`);
  }
  const usage = candidate.usage;
  const cost = usage.costState !== 'unpriced' && usage.costUsd !== null ? formatUsd(usage.costUsd, { estimated: usage.costState === 'estimated' }) : usage.costState;
  lines.push(`      usage: ${usage.turnCount} turn(s), ${usage.toolCallCount} tool call(s), cost ${cost}`);
  return lines;
}

function renderGroup(group: HeldMergeGroup): string {
  return [
    `  ${group.groupId}  workstream ${group.workstreamId}  ${group.sourceTitle}`,
    `    ready ${group.ready ? 'yes' : 'no'}  autoAccept ${group.autoAccept ? 'yes' : 'no'}  candidates ${group.candidates.length}`,
    ...group.candidates.flatMap(renderCandidate),
    ...renderJudgment(group.judgment),
  ].join('\n');
}

export function renderGroupList(groups: readonly HeldMergeGroup[]): string {
  if (groups.length === 0) {
    return ['Best-of-N held-merge groups', '  No groups are currently held for a winner pick.'].join('\n');
  }
  return [`Best-of-N held-merge groups (${groups.length})`, ...groups.map(renderGroup)].join('\n\n');
}

/** One loser's clean-up as observed: cleaned only when its worktree was seen gone. */
function renderLoser(loser: AttemptPickResult['losers'][number]): string {
  const { outcome } = loser;
  switch (outcome.state) {
    case 'done': return `    ${loser.id}: cleaned`;
    case 'pending': return `    ${loser.id}: still cleaning; check with \`${outcome.check}\``;
    case 'unknown':
    case 'failed': return `    ${loser.id}: not cleaned: ${outcome.refusal.reason}${outcome.refusal.next[0] ? ` ${outcome.refusal.next[0]}` : ''}`;
  }
}

export function renderPickResult(result: AttemptPickResult): string {
  return [
    `Picked winner ${result.winnerItemId} for group ${result.groupId}`,
    result.losers.length === 0 ? '  losers: none' : '  losers:',
    ...result.losers.map(renderLoser),
    `  auto-picked ${result.auto ? 'yes (judge auto-accept)' : 'no (explicit operator pick)'}`,
  ].join('\n');
}

export function renderJudgeProposal(groupId: string, judgment: AttemptJudgment): string {
  return [
    `Judge proposal for group ${groupId}`,
    ...renderJudgment(judgment),
    '',
    'This is a model judgment, not a decision. Confirm with:',
    `  goodvibes-agent fleet attempts pick ${groupId} <winnerItemId> --yes`,
  ].join('\n');
}

async function handleFleetAttemptsList(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args, ['workstream']);
  const workstreamId = operatorFlagValue(parsed, 'workstream');
  try {
    const { groups } = await hostVerbs(runtime).invoke<{ readonly groups: readonly HeldMergeGroup[] }>(
      'fleet.attempts.list', workstreamId ? { workstreamId } : {},
    );
    return { output: jsonOrText(runtime, { ok: true, groups }, renderGroupList(groups)), exitCode: 0 };
  } catch (error) {
    return errorFailure(runtime, error, 'list');
  }
}

async function handleFleetAttemptsPick(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args);
  const groupId = parsed.positionals[0];
  const winnerItemId = parsed.positionals[1];
  if (!groupId || !winnerItemId) return usageFailure(runtime, FLEET_ATTEMPTS_PICK_USAGE);
  if (!parsed.yes) {
    const error = `Refusing to pick a winner for group ${groupId} without --yes. Losing siblings' worktrees are cleaned on pick.`;
    return {
      output: jsonOrText(runtime, { ok: false, kind: 'confirmation_required', error, next: [`fleet attempts pick ${groupId} ${winnerItemId} --yes`] }, error),
      exitCode: 2,
    };
  }
  try {
    const answer = await hostVerbs(runtime).invoke<AttemptPickResult & { readonly applied?: boolean }>(
      'fleet.attempts.pick', { groupId, winnerItemId, confirm: true },
    );
    const { applied: _applied, ...result } = answer;
    // The winner merged; a loser whose clean-up failed is reported and exits 1, one still cleaning exits 0 with its check.
    const failed = result.losers.some((loser) => loser.outcome.state === 'failed' || loser.outcome.state === 'unknown');
    return { output: jsonOrText(runtime, { ok: !failed, ...result }, renderPickResult(result)), exitCode: failed ? 1 : 0 };
  } catch (error) {
    return errorFailure(runtime, error, 'pick');
  }
}

async function handleFleetAttemptsJudge(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const parsed = parseOperatorCommandArgs(args);
  const groupId = parsed.positionals[0];
  if (!groupId) return usageFailure(runtime, FLEET_ATTEMPTS_JUDGE_USAGE);
  try {
    const judgment = await hostVerbs(runtime).invoke<AttemptJudgment>('fleet.attempts.judge', { groupId });
    return { output: jsonOrText(runtime, { ok: true, judgment }, renderJudgeProposal(groupId, judgment)), exitCode: 0 };
  } catch (error) {
    return errorFailure(runtime, error, 'judge');
  }
}

async function handleFleetAttemptsCommand(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const [sub = 'list', ...rest] = args;
  switch (sub.toLowerCase()) {
    case 'list':
      return handleFleetAttemptsList(runtime, rest);
    case 'pick':
      return handleFleetAttemptsPick(runtime, rest);
    case 'judge':
      return handleFleetAttemptsJudge(runtime, rest);
    default:
      return usageFailure(runtime, FLEET_USAGE);
  }
}

export async function handleFleetCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const [sub, ...rest] = commandArgsWithLiteralMarker(runtime.cli);
  switch ((sub ?? '').toLowerCase()) {
    case 'attempts':
      return handleFleetAttemptsCommand(runtime, rest);
    default:
      return usageFailure(runtime, FLEET_USAGE);
  }
}

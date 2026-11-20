/**
 * `/ci`, described once (command-actions/) for both terminal apps: a one-shot
 * per-job CI status and standing CI watches, over the daemon's `ci.status`
 * and `ci.watches.*` methods. Each app says how it reaches the daemon (the
 * terminal app over its operator wire, the Agent through its connected host).
 * The verdict is the per-job conclusions, never a rollup: every job and its
 * conclusion is listed, and continue-on-error jobs are shown as violations.
 */
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionValues, CommandActionContext, InputDescription } from './command-actions/types.js';
import { listInput, readAction, textInput } from './described-command-kit.js';

type CiMethod = 'ci.status' | 'ci.watches.list' | 'ci.watches.create' | 'ci.watches.run' | 'ci.watches.delete';
/** Call one CI method on the daemon this app works with; throws a refusal saying why it could not. */
export type CiInvoke<Ctx> = <M extends CiMethod>(ctx: Ctx, method: M, input: OperatorMethodInput<M>) => Promise<OperatorMethodOutput<M>>;
export type CiReport = OperatorMethodOutput<'ci.status'>['report'];
export type CiWatchSubscription = OperatorMethodOutput<'ci.watches.list'>['watches'][number];

interface CiTarget { readonly repo: string; readonly ref?: string; readonly prNumber?: number }

/** `owner/repo`, `owner/repo#123` (a pull request) or `owner/repo@ref` (a branch, tag or commit). */
export function parseCiTarget(token: string): CiTarget | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const pr = trimmed.match(/^([^#@]+)#(\d+)$/);
  if (pr) return pr[1] ? { repo: pr[1], prNumber: Number(pr[2]) } : null;
  const ref = trimmed.match(/^([^#@]+)@(.+)$/);
  if (ref) return ref[1] && ref[2] ? { repo: ref[1], ref: ref[2] } : null;
  return { repo: trimmed };
}

export function formatCiTarget(target: { readonly repo: string; readonly ref?: string | undefined; readonly prNumber?: number | undefined }): string {
  if (target.prNumber) return `${target.repo}#${target.prNumber}`;
  if (target.ref) return `${target.repo}@${target.ref}`;
  return target.repo;
}

/** Per-job listing: every job and its conclusion, never a rollup. */
export function renderCiReport(report: CiReport): string {
  const failing = report.jobs.filter((job) => job.status === 'completed' && job.conclusion !== 'success').map((job) => job.name);
  const lines: string[] = [];
  if (report.overall !== 'passed' && failing.length > 0) lines.push(`FAILING: ${failing.join(', ')}`);
  lines.push(`CI ${report.overall.toUpperCase()} for ${formatCiTarget(report)}`);
  for (const job of report.jobs) lines.push(`  - ${job.name}: ${job.status === 'completed' ? (job.conclusion ?? 'no-conclusion') : job.status}${job.continueOnError ? ' [continue-on-error]' : ''}`);
  for (const violation of report.violations) lines.push(`  ! ${violation}`);
  return lines.join('\n');
}

export function renderCiWatch(watch: CiWatchSubscription): string {
  const parts = [`  ${watch.id}  ${formatCiTarget(watch)}`, `    delivery: ${watch.deliveryChannel}`, `    fix-session on failure: ${watch.triggerFixSession ? 'yes' : 'no'}`];
  if (watch.lastOverall) parts.push(`    last checked: ${watch.lastOverall}`);
  if (watch.expiresAt !== undefined) parts.push(`    ends without a verdict at: ${new Date(watch.expiresAt).toISOString()}`);
  if (watch.repair) {
    const retry = watch.repair.retryAt !== undefined ? `, next try ${new Date(watch.repair.retryAt).toISOString()}` : '';
    parts.push(`    repair: ${watch.repair.outcome} after ${watch.repair.attempts} attempt(s)${watch.repair.reason ? ` (${watch.repair.reason})` : ''}${retry}`);
  }
  return parts.join('\n');
}

export interface CiCommandContext extends CommandActionContext {
  /** Offer the started fix session through the shell's open-session key, where the app has one. */
  readonly armFixSessionAttach?: ((sessionId: string) => void) | undefined;
}

let invokeOf: CiInvoke<unknown> | undefined;
const WATCHES = defineList<unknown>({
  name: 'ci.watches',
  async read(ctx) {
    if (!invokeOf) return [];
    const { watches } = await invokeOf(ctx, 'ci.watches.list', {});
    return watches.map((watch): ListRow => ({ value: watch.id, label: formatCiTarget(watch), detail: `to ${watch.deliveryChannel}`, ...(watch.lastOverall ? { state: watch.lastOverall } : {}) }));
  },
  operator: { method: 'ci.watches.list', input: {}, rows: { from: 'watches', value: 'id', label: 'repo', detail: 'deliveryChannel', state: 'lastOverall' } },
});

const TARGET: InputDescription = textInput({ id: 'target', label: 'Repository', help: 'owner/repo, owner/repo#123 for a pull request, or owner/repo@branch', why: 'a repository on GitHub', typed: { position: 1 } });
const WATCH: InputDescription = listInput({ id: 'watch', label: 'Watch', help: 'Your standing CI watches', list: WATCHES });

function targetOf(values: ActionValues): CiTarget {
  const target = parseCiTarget(values.target ?? '');
  if (!target) throw commandRefusal(`"${values.target}" is not a repository: owner/repo, owner/repo#123 or owner/repo@branch.`);
  return target;
}
function targetInput(target: CiTarget) {
  return { repo: target.repo, ...(target.ref !== undefined ? { ref: target.ref } : {}), ...(target.prNumber !== undefined ? { prNumber: target.prNumber } : {}) };
}

/** Register `/ci` with how this app reaches the daemon's CI methods. */
export function registerCiCommand<Ctx extends CiCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, invoke: CiInvoke<Ctx>): void {
  invokeOf = invoke as CiInvoke<unknown>;
  registry.register(defineCommand<Ctx>({
    name: 'ci',
    title: 'CI checks',
    summary: 'See a repository\'s CI job by job, and keep standing watches that tell you when it fails',
    group: 'Work',
    report: 'watches',
    actions: [
      readAction<Ctx>({
        id: 'watches', label: 'See your CI watches', word: 'watches',
        sentence: 'Lists every standing CI watch, where it reports, and its last verdict.',
        operator: { method: 'ci.watches.list', fields: {} },
        async run(_values, ctx) {
          const { watches } = await invoke(ctx, 'ci.watches.list', {});
          return watches.length === 0 ? 'No standing CI watches. Start one with /ci watch <repo> <channel>.' : ['CI watches:', ...watches.map(renderCiWatch)].join('\n');
        },
      }),
      readAction<Ctx>({
        id: 'status', label: 'Check a repository\'s CI now', word: 'status', inputs: [TARGET],
        sentence: 'Shows each CI job of {target} and its conclusion, and the verdict they give together.', example: { target: 'acme/web#42' },
        operator: { method: 'ci.status', fields: { repo: 'target' } },
        async run(values, ctx) { return renderCiReport((await invoke(ctx, 'ci.status', targetInput(targetOf(values)))).report); },
      }),
      {
        id: 'watch', label: 'Watch a repository\'s CI', word: 'watch',
        inputs: [
          TARGET,
          textInput({ id: 'channel', label: 'Tell me on', help: 'Where a failure is reported: a channel kind (slack) or kind:address', why: 'a channel kind, or kind:address', typed: { position: 2 } }),
          { id: 'fix', label: 'On a failure', help: 'Only tell you, or also start a session that tries to fix it', kind: 'choice',
            choices: [{ value: 'tell', label: 'Only tell me' }, { value: 'fix', label: 'Also start a fix session', help: 'A session starts on its own and spends model time.', risk: 'spends-money' }],
            required: { default: 'tell', defaultMeans: 'only tell me' }, typed: { flag: '--fix-session', switchOn: 'fix' } },
        ],
        sentence: 'The daemon checks {target}\'s CI until it passes or ends, and reports a failure to {channel}, until you change it.', done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'unwatch',
        operator: { method: 'ci.watches.create', fields: { repo: 'target', deliveryChannel: 'channel' } }, example: { target: 'acme/web#42', channel: 'slack' },
        async run(values, ctx) {
          const { watch } = await invoke(ctx, 'ci.watches.create', { ...targetInput(targetOf(values)), deliveryChannel: values.channel!, triggerFixSession: values.fix === 'fix' });
          return `Watching ${formatCiTarget(watch)}; failures go to ${watch.deliveryChannel} (watch ${watch.id}).`;
        },
      },
      {
        id: 'run', label: 'Check a watch now', word: 'run', inputs: [WATCH],
        sentence: '{watch} is checked now; a failure is reported and, if it says so, a fix session starts.', done: '',
        touches: 'another-machine', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'ci.watches.run', fields: { watchId: 'watch' } }, example: { watch: 'w-31c' },
        async run(values, ctx) {
          const result = await invoke(ctx, 'ci.watches.run', { watchId: values.watch! });
          // Offer the spawned session through the shell's open-session key, the same flow as every other fix-session start.
          if (result.fixSessionId) ctx.armFixSessionAttach?.(result.fixSessionId);
          return [
            renderCiReport(result.report),
            `notified: ${result.notified ? 'yes' : 'no'}${result.notificationId ? ` (${result.notificationId})` : ''}`,
            `fix-session triggered: ${result.fixSessionTriggered ? 'yes' : 'no'}`,
            ...(result.fixSessionError ? [`fix-session not started: ${result.fixSessionError}`] : []),
            ...(result.retired ? [`watch ended${result.endedReason ? `: ${result.endedReason}` : ''}`] : []),
          ].join('\n');
        },
      },
      {
        id: 'unwatch', label: 'Stop watching a repository', word: 'unwatch', inputs: [WATCH],
        sentence: '{watch} is deleted; its repository is no longer checked.', done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
        operator: { method: 'ci.watches.delete', fields: { watchId: 'watch' } }, example: { watch: 'w-31c' },
        async run(values, ctx) {
          const result = await invoke(ctx, 'ci.watches.delete', { watchId: values.watch! });
          if (!result.deleted) throw commandRefusal(`No CI watch has the id ${values.watch}.`, '/ci watches lists them.');
          return `Deleted watch ${values.watch}.`;
        },
      },
    ],
  }));
}

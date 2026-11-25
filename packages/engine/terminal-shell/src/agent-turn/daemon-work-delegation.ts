/**
 * daemon-work-delegation.ts, a terminal program's delegations run on the
 * daemon's one runner (tools/agent/work-delegation.ts). A model's `agent`
 * call that would have started a contract in this program (a decision model
 * set, not outside every contract), and a team's or a recipe's agents, are
 * handed to the daemon as a piece of work for this program's project and
 * conversation (`work.delegate`, the call naming both); the record that asked
 * follows that work and settles with its result.
 *
 * Following is reading: the work is read (`work.list`) when the daemon says a
 * run, a request or a plan changed and when its event stream is back, never
 * on a clock. The record's progress line is where the work stands in the Work
 * place's words. The work is the daemon's: closing this program stops only
 * the following (the work runs on, and its result waits in Work), and only
 * the conversation's own cancel of the record stops the work.
 */
import { subscribeDaemonEventFrames } from '@goodvibes/engine/platform/platform/runtime/client';
import type { AgentRecord, AgentWorkDelegation, DelegatedWork, DelegatedWorkUpdate } from '@goodvibes/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { ConnectedHostConfigReader } from './connected-host-client.js';
import { captureOperatorConnection } from './operator-connection-owner.js';

export interface DaemonWorkDelegationOptions {
  readonly shellPaths: ShellPathService;
  readonly configManager: ConnectedHostConfigReader;
  readonly program: 'tui' | 'agent';
}

export interface DaemonWorkDelegation extends AgentWorkDelegation {
  /** The program is closing: stop following every work (each runs on; its result waits in Work). Never stops a work. */
  close(): void;
}

/** The longest task text one piece of work takes (the ledger's limit on what was asked). */
const GOAL_LIMIT = 20_000;

type Answer = Readonly<Record<string, unknown>>;
const record = (value: unknown): Answer => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Answer : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const list = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];

/** Where a piece of work stands, as the Work place says it (work-place.ts STATE_WORDS). */
const STATE_WORDS: Readonly<Record<string, string>> = {
  'not-started': 'in Work, not started', 'plan-waiting': 'its plan waits for you in Work', starting: 'starting on the daemon',
  interrupted: 'cut off when the daemon stopped; go on with it in Work', running: 'running on the daemon',
  'needs-you': 'needs you: answer it in Work', 'step-failed': 'a step failed: run it again, go on without it or stop it in Work',
};

/** Where a piece of work waits on the owner in Work: a headless run stops waiting there and says so. */
// Not "not started": a work handed over is started at once, and reads so only until its run is first seen.
const WAITS_ON_OWNER: ReadonlySet<string> = new Set(['plan-waiting', 'interrupted', 'needs-you', 'step-failed']);

/** What the task the record carries asks, as one piece of work: its words, and what done means when it said. */
function goalOf(owner: AgentRecord): string {
  const parts = [owner.task.trim(), owner.context?.trim() ? `What it was given to go on:\n${owner.context.trim()}` : ''].filter(Boolean);
  const goal = parts.join('\n\n');
  return goal.length > GOAL_LIMIT ? `${goal.slice(0, GOAL_LIMIT - 3)}...` : goal;
}

/** The result a finished piece of work gives the conversation: its answer, else its report and the results it met. */
function resultOf(work: Answer): string {
  const run = record(work['run']);
  const answer = text(run['answer']);
  if (answer) return answer;
  const report = text(record(work['attempt'])['report']);
  const results = list(run['results']).map(record).map((result) => `- ${text(result['text'])}: ${text(result['status']) || 'not shown'}`);
  return [report, results.length > 0 ? `Results:\n${results.join('\n')}` : ''].filter(Boolean).join('\n\n') || `"${text(work['title'])}" is done.`;
}

export function createDaemonWorkDelegation(options: DaemonWorkDelegationOptions): DaemonWorkDelegation {
  const following = new Set<() => void>();
  let closing = false;

  /**
   * One Work capability run through this program's own daemon credential, the one a person's press in the Work place
   * uses: the work it makes is the owner's, so he reads, answers and stops it in Work as any of his work (a model's
   * delegated credential would make it that credential's, which the owner's Work then cannot read). No person's claim:
   * the daemon decides it under the owner's mode, as any caller's.
   */
  async function ask(id: string, inputs: Record<string, string>): Promise<{ readonly ok: true; readonly text: string; readonly data: Answer } | { readonly ok: false; readonly error: string }> {
    const connection = captureOperatorConnection(options.shellPaths, options.configManager, () => {});
    if (!connection.token) return { ok: false, error: `auth_required: ${connection.unavailable?.reason ?? 'no daemon credential was found'}; nothing was sent.` };
    connection.assertCurrent();
    let response: Response;
    try {
      response = await (connection.fetch ?? fetch)(`${connection.baseUrl}/api/control-plane/methods/${encodeURIComponent('capabilities.run')}/invoke`, {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ body: { id, inputs, workingDirectory: options.shellPaths.workingDirectory, program: options.program } }),
      });
    } catch (error) {
      return { ok: false, error: `The daemon did not answer, so nothing was handed over (${summarizeError(error)}).` };
    }
    const body = record(await response.json().catch(() => null));
    if (body['code'] === 'OWNER_APPROVAL_PENDING') return { ok: false, error: text(body['state']) || `${id} waits for the owner in Waiting for you.` };
    if (!response.ok || body['ok'] === false) {
      const next = Array.isArray(body['next']) && typeof body['next'][0] === 'string' ? ` ${body['next'][0]}` : '';
      return { ok: false, error: `${text(body['error']) || text(body['text']) || `The daemon answered ${response.status}.`}${next}` };
    }
    return { ok: true, text: text(body['text']), data: record(body['data']) };
  }

  /** One read of this project's work (`work.list`): a read, so nobody is asked. */
  async function readWork(workId: string): Promise<Answer | undefined> {
    const read = await ask('work.list', {});
    if (!read.ok) throw new Error(read.error);
    return list(read.data['works']).map(record).find((work) => work['id'] === workId);
  }

  return {
    async delegate(owner, { signal, report }): Promise<DelegatedWork> {
      signal.throwIfAborted();
      const criteria = (owner.successCriteria ?? []).map((line) => line.trim()).filter(Boolean).join('\n');
      const ran = await ask('work.delegate', { goal: goalOf(owner), ...(criteria ? { criteria } : {}) });
      if (!ran.ok) throw new Error(ran.error);
      const workId = text(ran.data['work']);
      if (!workId) throw new Error(ran.text || 'The daemon did not say which piece of work it made.');
      const title = text(ran.data['title']) || owner.task.split('\n')[0]!.trim();
      const planWaiting = ran.data['planWaiting'] === true;
      report({ kind: 'progress', line: planWaiting ? `"${title}": its plan waits for you in Work` : `"${title}": handed to the daemon; it shows in Work`, waiting: planWaiting });

      let ended = false;
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => { settle = resolve; });
      let stopFollowing: () => void = () => {};
      const finish = (update?: DelegatedWorkUpdate): void => {
        if (ended) return;
        ended = true;
        if (update) report(update);
        stopFollowing();
        following.delete(end);
        signal.removeEventListener('abort', onAbort);
        settle();
      };
      // The program closing ends the following only: the work runs on and its result waits in Work.
      const end = (): void => finish();
      following.add(end);

      let lastLine = '';
      let reading = false;
      let again = false;
      const read = async (): Promise<void> => {
        if (ended) return;
        if (reading) { again = true; return; }
        reading = true;
        try {
          do {
            again = false;
            const work = await readWork(workId).catch((error: unknown) => {
              logger.debug('[work delegation] the work could not be read; it is read again on the next change', { workId, error: summarizeError(error) });
              return null;
            });
            if (ended || work === null) continue;
            if (work === undefined) { finish({ kind: 'stopped', reason: `"${title}" is no longer in Work` }); return; }
            const state = text(work['state']);
            const runView = record(work['run']);
            if (state === 'done') { finish({ kind: 'done', output: resultOf(work) }); return; }
            if (state === 'failed') {
              // The run's own line says "The work failed: <why>"; the why alone is said here.
              const why = (text(runView['statusLine']) || text(record(work['attempt'])['blocker']) || 'it failed')
                .replace(/^(?:The work failed:\s*)+/iu, '').replace(/[.\s]+$/u, '');
              finish({ kind: 'failed', error: `The work "${title}" failed: ${why}. It is in Work, where it can be asked for again.` });
              return;
            }
            if (state === 'stopped') { finish({ kind: 'stopped', reason: `the work "${title}" was stopped` }); return; }
            const held = text(runView['held']);
            const line = [`"${title}": ${STATE_WORDS[state] ?? state}`, text(runView['statusLine']), held ? `Held back: ${held}` : ''].filter(Boolean).join('. ');
            if (line !== lastLine) { lastLine = line; report({ kind: 'progress', line, waiting: WAITS_ON_OWNER.has(state) }); }
          } while (again && !ended);
        } finally {
          reading = false;
        }
      };

      // The conversation's own cancel of the record stops the work; the program closing does not.
      const onAbort = (): void => {
        if (closing || ended) return;
        void stopWork('the conversation stopped it');
      };
      const stopWork = async (reason: string): Promise<void> => {
        const stopped = await ask('work.cancel', { work: workId });
        if (!stopped.ok) logger.warn('[work delegation] the work was not stopped', { workId, error: stopped.error });
        finish({ kind: 'stopped', reason });
      };
      signal.addEventListener('abort', onAbort, { once: true });

      const connection = captureOperatorConnection(options.shellPaths, options.configManager, () => {});
      stopFollowing = subscribeDaemonEventFrames(
        { baseUrl: connection.baseUrl, getAuthToken: () => connection.token, workingDirectory: options.shellPaths.workingDirectory, ...(connection.fetch ? { fetchImpl: connection.fetch } : {}) },
        { domains: ['workspace', 'contracts'], events: ['NATIVE_REQUEST_CHANGED', 'contracts'], lists: ['work'] },
        () => { void read(); },
        (state) => { if (state.kind === 'open') void read(); },
      );
      void read();
      return {
        workId,
        settled,
        cancel(reason) {
          if (ended) return false;
          void stopWork(reason);
          return true;
        },
      };
    },
    close() {
      closing = true;
      for (const end of [...following]) end();
    },
  };
}

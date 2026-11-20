import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { findSessionCandidates, type SessionManager } from '@goodvibes/engine/platform/platform/sessions';
import type { RuntimeStore } from '@goodvibes/engine/platform/platform/runtime/state';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { redactSensitiveDataAsync } from '@goodvibes/engine/platform/platform/utils';
import { createTasksClient, type DaemonVerbCaller } from '@goodvibes/engine/platform/platform/runtime/client';
import { cliCommandDone, cliCommandRefusal, formatJsonOrText, type CliCommandOutput } from './cli-output.js';
interface WorkspaceCommandRuntime {
  readonly cli: { readonly commandArgs: readonly string[]; readonly flags: { readonly outputFormat?: string | undefined } };
}
interface WorkspaceCommandServices {
  readonly sessionManager: SessionManager;
  readonly shellPaths: ShellPathService;
  readonly runtimeStore: RuntimeStore;
}
export function createCliWorkspaceCommands<Runtime extends WorkspaceCommandRuntime, Services extends WorkspaceCommandServices>(
  withRuntimeServices: <T>(runtime: Runtime, fn: (services: Services) => Promise<T> | T) => Promise<T>,
  policy: {
    readonly binary: (runtime: Runtime) => string;
    readonly time: (timestamp: number) => string;
    readonly inline: boolean;
    readonly submit: (runtime: Runtime, args: string[]) => Promise<CliCommandOutput>;
    readonly allowSubmit: boolean;
    /** The daemon whose tasks `tasks list|show` read; its `probe()` says why when none can be asked. */
    readonly verbs: (runtime: Runtime, services: Services) => DaemonVerbCaller;
  },
) {
  /** `sessions`; null for `resume <id>`, which the caller opens interactively. */
  async function handleSessions(runtime: Runtime): Promise<CliCommandOutput | null> {
    const usage = (text: string): CliCommandOutput => cliCommandRefusal(runtime.cli, 'usage', text);
    const ambiguous = (target: string, matches: readonly { readonly name: string }[]): CliCommandOutput =>
      cliCommandRefusal(runtime.cli, 'session_ambiguous', `Ambiguous session: ${target}. Use an exact ID: ${matches.map((session) => session.name).join(', ')}`);
    const notFound = (target: string): CliCommandOutput =>
      cliCommandRefusal(runtime.cli, 'session_not_found', `Session not found${policy.inline ? ': ' : ' '}${target}`, [`${policy.binary(runtime)} sessions list`]);
    return await withRuntimeServices(runtime, async (services) => {
      const [sub = 'list', ...rest] = runtime.cli.commandArgs;
      const sessions = services.sessionManager.list();
      if (sub === 'list') {
        const value = sessions;
        return cliCommandDone(formatJsonOrText(runtime.cli)(
          value,
          [
            `GoodVibes sessions (${sessions.length})`,
            ...sessions
              .slice(0, 50)
              .map(
                (session) =>
                  `  ${session.name}  messages${policy.inline ? '=' : ' '}${session.messageCount}  ${policy.time(session.timestamp)}  ${session.title || '(untitled)'}`,
              ),
          ].join('\n'),
        ));
      }
      if (sub === 'show' || sub === 'info') {
        const target = rest.join(' ').trim();
        if (!target) return usage(`Usage: ${policy.binary(runtime)} sessions show <id|name>`);
        const candidates = findSessionCandidates(sessions, target);
        if (candidates.length > 1) return ambiguous(target, candidates);
        const found = candidates[0];
        if (!found) return notFound(target);
        return cliCommandDone(formatJsonOrText(runtime.cli)(
          found,
          [
            `Session ${found.name}`,
            `  title${policy.inline ? ': ' : ' '}${found.title || '(untitled)'}`,
            `  messages${policy.inline ? ': ' : ' '}${found.messageCount}`,
            `  provider/model${policy.inline ? ': ' : ' '}${found.provider}/${found.model}`,
            `  updated${policy.inline ? ': ' : ' '}${policy.time(found.timestamp)}`,
            `  file${policy.inline ? ': ' : ' '}${found.filePath}`,
          ].join('\n'),
        ));
      }
      if (sub === 'export') {
        const target = rest[0];
        const outputPath = rest[1];
        if (!target) return usage(`Usage: ${policy.binary(runtime)} sessions export <id|name> [path]`);
        const candidates = findSessionCandidates(sessions, target);
        if (candidates.length > 1) return ambiguous(target, candidates);
        const found = candidates[0];
        if (!found) return notFound(target);
        const data = services.sessionManager.load(found.name);
        // The same redaction the in-session export applies: the file is the durable transcript copy and tends to be shared.
        const text = (await redactSensitiveDataAsync(JSON.stringify({ name: found.name, ...data }, null, 2))) + '\n';
        if (outputPath) {
          const targetPath = services.shellPaths.resolveWorkspacePath(outputPath);
          mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
          writeFileSync(targetPath, text, { encoding: 'utf-8', mode: 0o600 });
          // The mode above applies only when the file is created; an export over an older, wider file must still end owner-only.
          chmodSync(targetPath, 0o600);
          return cliCommandDone(policy.inline ? `Session exported: ${targetPath}` : 'Session exported\n  path ' + targetPath);
        }
        return cliCommandDone(text.trimEnd());
      }
      if (sub === 'resume') {
        const target = rest.join(' ').trim();
        return target ? null : usage(`Usage: ${policy.binary(runtime)} sessions resume <id|name>`);
      }
      return usage(`Usage: ${policy.binary(runtime)} sessions list|show <id>|export <id> [path]|resume <id>`);
    });
  }
  async function handleTasks(runtime: Runtime): Promise<CliCommandOutput> {
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    if (sub === 'submit') return policy.submit(runtime, rest);
    const usage = (text: string): CliCommandOutput => cliCommandRefusal(runtime.cli, 'usage', text);
    if (sub !== 'list' && sub !== 'show') return usage(`Usage: ${policy.binary(runtime)} tasks list|show <taskId>${policy.allowSubmit ? '|submit <prompt>' : ''}`);
    if (sub === 'show' && !rest[0]) return usage(`Usage: ${policy.binary(runtime)} tasks show <taskId>`);
    return await withRuntimeServices(runtime, async (services) => {
      // This process started a moment ago, so its own store is near empty; the tasks a user means run in the daemon.
      const store = services.runtimeStore;
      const tasks = createTasksClient({
        local: {
          list: (limit) => [...store.getState().tasks.tasks.values()].slice(0, limit),
          get: (taskId) => store.getState().tasks.tasks.get(taskId) ?? null,
        },
        verbs: policy.verbs(runtime, services),
      });
      const noDaemon = (reason: string): string => `no daemon could be asked (${reason}); tasks exist only in the daemon or inside a running session`;
      if (sub === 'list') {
        const { tasks: listed, daemonUnavailable } = await tasks.list(500);
        const rows = listed.map(({ task }) => task);
        return cliCommandDone(formatJsonOrText(runtime.cli)(
          { tasks: rows, returned: rows.length, complete: daemonUnavailable === null, ...(daemonUnavailable ? { daemonUnavailable } : {}) },
          [
            'GoodVibes tasks',
            ...(rows.length === 0 && daemonUnavailable === null ? ['  The daemon has no tasks.'] : []),
            ...rows.map((task) => `  ${task.id} ${task.status} ${task.kind} ${task.title}`),
            ...(daemonUnavailable ? [`  ${rows.length === 0 ? 'None listed' : 'Partial list'}: ${noDaemon(daemonUnavailable)}.`] : []),
          ].join('\n'),
        ));
      }
      const taskId = rest[0] as string;
      const { found, daemonUnavailable } = await tasks.lookup(taskId);
      if (found) return cliCommandDone(JSON.stringify(found.task, null, 2));
      return cliCommandRefusal(runtime.cli, daemonUnavailable ? 'daemon_unavailable' : 'task_not_found',
        `Unknown task${policy.inline ? ': ' : ' '}${taskId}${daemonUnavailable ? ` (${noDaemon(daemonUnavailable)})` : ''}`,
        [`${policy.binary(runtime)} tasks list`]);
    });
  }
  return { handleSessions, handleTasks };
}

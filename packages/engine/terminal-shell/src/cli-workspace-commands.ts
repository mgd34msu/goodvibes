import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { findSessionCandidates, type SessionManager } from '@goodvibes-jev/engine/sdk/platform/sessions';
import type { RuntimeStore } from '@goodvibes-jev/engine/sdk/platform/runtime/state';
import type { ShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { formatJsonOrText } from './cli-output.js';
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
    readonly submit: (runtime: Runtime, args: string[]) => Promise<string>;
    readonly allowSubmit: boolean;
    readonly emptyTasks: string;
  },
) {
  async function handleSessions(runtime: Runtime): Promise<string | null> {
    return await withRuntimeServices(runtime, (services) => {
      const [sub = 'list', ...rest] = runtime.cli.commandArgs;
      const sessions = services.sessionManager.list();
      if (sub === 'list') {
        const value = sessions;
        return formatJsonOrText(runtime.cli)(
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
        );
      }
      if (sub === 'show' || sub === 'info') {
        const target = rest.join(' ').trim();
        if (!target) return `Usage: ${policy.binary(runtime)} sessions show <id|name>`;
        const candidates = findSessionCandidates(sessions, target);
        if (candidates.length > 1)
          return `Ambiguous session: ${target}. Use an exact ID: ${candidates.map((session) => session.name).join(', ')}`;
        const found = candidates[0];
        if (!found) return `Session not found${policy.inline ? ': ' : ' '}${target}`;
        return formatJsonOrText(runtime.cli)(
          found,
          [
            `Session ${found.name}`,
            `  title${policy.inline ? ': ' : ' '}${found.title || '(untitled)'}`,
            `  messages${policy.inline ? ': ' : ' '}${found.messageCount}`,
            `  provider/model${policy.inline ? ': ' : ' '}${found.provider}/${found.model}`,
            `  updated${policy.inline ? ': ' : ' '}${policy.time(found.timestamp)}`,
            `  file${policy.inline ? ': ' : ' '}${found.filePath}`,
          ].join('\n'),
        );
      }
      if (sub === 'export') {
        const target = rest[0];
        const outputPath = rest[1];
        if (!target) return `Usage: ${policy.binary(runtime)} sessions export <id|name> [path]`;
        const candidates = findSessionCandidates(sessions, target);
        if (candidates.length > 1)
          return `Ambiguous session: ${target}. Use an exact ID: ${candidates.map((session) => session.name).join(', ')}`;
        const found = candidates[0];
        if (!found) return `Session not found${policy.inline ? ': ' : ' '}${target}`;
        const data = services.sessionManager.load(found.name);
        const text = JSON.stringify({ name: found.name, ...data }, null, 2) + '\n';
        if (outputPath) {
          const targetPath = services.shellPaths.resolveWorkspacePath(outputPath);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, text, 'utf-8');
          return policy.inline ? `Session exported: ${targetPath}` : 'Session exported\n  path ' + targetPath;
        }
        return text.trimEnd();
      }
      if (sub === 'resume') {
        const target = rest.join(' ').trim();
        return target ? null : `Usage: ${policy.binary(runtime)} sessions resume <id|name>`;
      }
      return `Usage: ${policy.binary(runtime)} sessions list|show <id>|export <id> [path]|resume <id>`;
    });
  }
  async function handleTasks(runtime: Runtime): Promise<string> {
    const [sub = 'list', ...rest] = runtime.cli.commandArgs;
    if (sub === 'submit') return policy.submit(runtime, rest);
    return await withRuntimeServices(runtime, (services) => {
      const tasks = [...services.runtimeStore.getState().tasks.tasks.values()];
      if (sub === 'list') {
        return tasks.length === 0
          ? policy.emptyTasks
          : ['GoodVibes tasks', ...tasks.map((task) => `  ${task.id} ${task.status} ${task.kind} ${task.title}`)].join('\n');
      }
      if (sub === 'show') {
        if (!rest[0]) return `Usage: ${policy.binary(runtime)} tasks show <taskId>`;
        const task = tasks.find((candidate) => candidate.id === rest[0]);
        return task ? JSON.stringify(task, null, 2) : `Unknown task${policy.inline ? ': ' : ' '}${rest[0] ?? ''}`;
      }
      return `Usage: ${policy.binary(runtime)} tasks list|show <taskId>${policy.allowSubmit ? '|submit <prompt>' : ''}`;
    });
  }
  return { handleSessions, handleTasks };
}

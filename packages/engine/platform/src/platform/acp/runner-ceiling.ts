import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SubagentTask } from './protocol.js';

/**
 * The runner ceiling an ACP subagent is held to. The subagent runs its own
 * tools, so the one place this side decides is its permission ask: a tool call
 * outside the ceiling is answered with a refusal before the owner or Jev is
 * asked. Code decides it from the call's declared kind and paths; no model.
 */

/** The runner tool each ACP tool kind needs; `think` needs none. Any other kind is treated as a command. */
const ACP_KIND_TOOLS: Readonly<Record<string, readonly string[]>> = {
  read: ['read'],
  search: ['find', 'read'],
  fetch: ['fetch'],
  edit: ['edit', 'write'],
  delete: ['write', 'edit'],
  move: ['write', 'edit'],
  execute: ['exec'],
  think: [],
};

const PATH_WRITING_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move']);

/** The fields of an ACP tool call the ceiling reads. */
export interface RunnerToolCallLike {
  readonly kind?: string | null | undefined;
  readonly title?: string | null | undefined;
  readonly locations?: readonly { readonly path: string }[] | null | undefined;
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * Why this tool call is outside the runner's ceiling, or null when it is
 * inside. An empty tool list sets no tool ceiling; an empty write scope sets no
 * path ceiling (the working directory's own permission rules still apply).
 */
export function runnerCeilingRefusal(
  task: Pick<SubagentTask, 'tools' | 'writeScope' | 'workingDirectory'>,
  toolCall: RunnerToolCallLike,
): string | null {
  const kind = typeof toolCall.kind === 'string' && toolCall.kind ? toolCall.kind : 'other';
  const what = `this ${kind} call${toolCall.title ? ` (${toolCall.title})` : ''}`;
  const needs = ACP_KIND_TOOLS[kind] ?? ['exec'];
  if (task.tools.length > 0 && needs.length > 0 && !needs.some((tool) => task.tools.includes(tool))) {
    return `the runner may use ${task.tools.join(', ')}; ${what} needs ${needs.join(' or ')}`;
  }
  const scope = (task.writeScope ?? []).map((path) => resolve(task.workingDirectory, path));
  if (scope.length === 0) return null;
  if (kind === 'execute' || !(kind in ACP_KIND_TOOLS)) {
    return `the runner may write only inside ${scope.join(', ')}, and ${what} could write anywhere`;
  }
  if (!PATH_WRITING_KINDS.has(kind)) return null;
  const paths = (toolCall.locations ?? []).map((location) => resolve(task.workingDirectory, location.path));
  if (paths.length === 0) return `the runner may write only inside ${scope.join(', ')}, and ${what} names no path`;
  const outside = paths.filter((path) => !scope.some((root) => within(path, root)));
  return outside.length > 0 ? `the runner may write only inside ${scope.join(', ')}; ${what} writes ${outside.join(', ')}` : null;
}

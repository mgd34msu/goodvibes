/**
 * The prompt an autonomous schedule runs with: the task, what shows it is
 * done, and the operator policy every such run keeps. Built in one place for
 * the terminal apps' `/schedule change --task` and the Agent's autonomy
 * schedules, and for the daemon's `automation.schedules.preview`.
 */
export function buildAutonomySchedulePrompt(input: {
  readonly task: string;
  readonly successCriteria: string;
  readonly explicitUserRequest?: string | null;
}): string {
  return [
    'GoodVibes Agent autonomous schedule.',
    '',
    ...(input.explicitUserRequest ? ['Request provenance:', input.explicitUserRequest, ''] : []),
    'Task:',
    input.task,
    '',
    'Success criteria:',
    input.successCriteria,
    '',
    'Operator policy:',
    '- Run this as a visible GoodVibes Agent scheduled automation, not a hidden background job.',
    '- Use isolated Agent Knowledge routes only when lookup is needed; never use default knowledge or non-Agent knowledge spaces as fallback.',
    '- Perform each effect only under current recorded effect admission and its unchanged source and target constraints.',
    '- Do not self-expand the scope beyond the task and success criteria; report missing setup or ambiguous requirements instead of improvising.',
    '- Do not request GoodVibes TUI delegation unless this schedule explicitly delegates build/fix/review work and the user asked for that delegation.',
    '- Summarize what was checked, what changed, what still needs review, and the next user-visible action.',
  ].join('\n');
}

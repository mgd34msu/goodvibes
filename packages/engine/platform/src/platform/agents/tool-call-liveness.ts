/**
 * Whether an in-flight tool call still counts as a live agent for the
 * contract silence watchdog (`contract.heartbeatTimeoutMs`).
 *
 * An exec-style call bounds itself: each command runs until its own
 * `timeout_ms` (the call's when the command sets none), and a command with no
 * timeout streams its output to a progress file until it finishes or is
 * cancelled. Either way the tool owns its own deadline, so the runner keeps
 * the agent alive while that deadline holds. Every other tool (read, find,
 * analyze, ...) has no bound of its own and stays subject to the watchdog,
 * which is what turns a stalled search into a retry.
 */

const SELF_BOUNDED_TOOLS = new Set(['exec', 'precision_exec']);
/** exec's documented default retry attempts and its cap on one backoff wait. */
const DEFAULT_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_CAP_MS = 30_000;
/** Time for the tool to notice its own timeout and return. */
const DEADLINE_GRACE_MS = 60_000;

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function retryAttempts(retry: unknown): number {
  if (retry === null || typeof retry !== 'object') return 0;
  return positive((retry as Record<string, unknown>)['max']) ?? DEFAULT_RETRY_ATTEMPTS;
}

/**
 * The epoch time until which the call keeps its agent alive:
 * `Number.POSITIVE_INFINITY` for a command that waits without a timeout,
 * `undefined` for a tool that sets no bound of its own.
 */
export function selfBoundedCallDeadline(toolName: string, args: Record<string, unknown>, startedAt: number): number | undefined {
  if (!SELF_BOUNDED_TOOLS.has(toolName)) return undefined;
  const commands = Array.isArray(args['commands']) ? args['commands'] : [];
  if (commands.length === 0) return undefined;
  const callTimeout = positive(args['timeout_ms']);
  let total = 0;
  for (const command of commands) {
    const item = command !== null && typeof command === 'object' ? command as Record<string, unknown> : {};
    const timeout = positive(item['timeout_ms']) ?? callTimeout;
    if (timeout === undefined) return Number.POSITIVE_INFINITY;
    const attempts = 1 + retryAttempts(item['retry']);
    total += timeout * attempts + RETRY_DELAY_CAP_MS * (attempts - 1);
  }
  return startedAt + total + DEADLINE_GRACE_MS;
}

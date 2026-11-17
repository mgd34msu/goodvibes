import type { CapturedExecAvailability } from './captured-exec.js';
/**
 * JSON Schema definition for the `exec` tool.
 *
 * The exec tool runs shell commands, optionally in parallel or background,
 * with retry, timeout, expectation-checking, and pre-command file operations.
 */
export const EXEC_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    commands: {
      type: 'array',
      description: 'Commands to execute. Run sequentially by default, parallel if parallel=true.',
      items: {
        type: 'object',
        properties: {
          cmd: {
            type: 'string',
            description: 'Shell command to execute via sh -c. Special values manage background processes started'
              + ' with background: true: "bg_list", "bg_status <process_id>", "bg_output <process_id> [tail=<bytes>|from=<byte>]",'
              + ' "bg_stop <process_id>". bg_output reads the saved output: tail= the last bytes, from= onward from a byte offset.',
          },
          cmd_base64: {
            type: 'string',
            description: 'Base64-encoded command. Use when cmd contains special characters. Give cmd or cmd_base64, not both; entries that give both with different text are refused.',
          },
          working_dir: {
            type: 'string',
            description:
              'Per-command working directory override. Prefer the top-level working_dir for the project root.'
              + ' For a single-command call with no top-level working_dir, it is used as the working_dir.',
          },
          timeout_ms: {
            type: 'integer',
            minimum: 0,
            description: 'Optional per-command timeout in milliseconds. Omitted or 0 waits for completion or cancellation.',
          },
          env: {
            type: 'object',
            description: 'Additional environment variables merged with the current process env.',
            additionalProperties: { type: 'string' },
          },
          expect: {
            type: 'object',
            description: 'Expectations to validate after the command completes.',
            properties: {
              exit_code: {
                type: 'integer',
                description: 'Expected exit code.',
              },
              stdout_contains: {
                type: 'string',
                description: 'Substring that stdout must contain.',
              },
              stderr_contains: {
                type: 'string',
                description: 'Substring that stderr must contain.',
              },
            },
          },
          background: {
            type: 'boolean',
            description:
              'Run detached, returns immediately with a process_id.'
              + ' Manage it with later exec calls whose cmd is "bg_list", "bg_status <id>", "bg_output <id> [tail=<bytes>|from=<byte>]" or "bg_stop <id>".',
          },
          retry: {
            type: 'object',
            description: 'Retry configuration for transient failures.',
            properties: {
              max: {
                type: 'integer',
                minimum: 1,
                description: 'Maximum retry attempts. Default: 3.',
              },
              delay_ms: {
                type: 'integer',
                minimum: 0,
                description: 'Base delay between retries in ms. Default: 1000.',
              },
              max_delay_ms: {
                type: 'integer',
                minimum: 0,
                description: 'Max jitter cap for exponential backoff in ms. Default: 30000.',
              },
              backoff: {
                type: 'string',
                enum: ['fixed', 'exponential'],
                description: 'Backoff strategy. Default: exponential.',
              },
              on: {
                type: 'array',
                items: { type: 'string', enum: ['network', 'lock', 'busy', 'oom'] },
                description: 'Error categories to retry on. Default: ["network", "lock", "busy"].',
              },
            },
          },
          until: {
            type: 'object',
            description:
              'Pattern-based early termination. Watch stdout/stderr for a regex match.',
            properties: {
              pattern: {
                type: 'string',
                description: 'Regex to watch for in combined stdout/stderr.',
              },
              timeout_ms: {
                type: 'integer',
                minimum: 0,
                description: 'Optional pattern-wait timeout in ms. Omitted uses the command timeout; 0 waits until cancellation.',
              },
              kill_after: {
                type: 'boolean',
                description:
                  'Kill the process when pattern matches. Default false (promotes to background).',
              },
            },
            required: ['pattern'],
          },
          progress: {
            type: 'boolean',
            description:
              'Stream stdout lines to a pollable progress file at .goodvibes/.overflow/{id}-progress.txt.'
              + ' true: the file is created when the command starts and kept. Unset (with no timeout or timeout_ms > 30000):'
              + ' a file is created only once the command has run 30 s, and removed when it finishes; a stopped command keeps it.'
              + ' false: no file. The result includes a progress_file path when one is kept.',
          },
          interactive: {
            type: 'boolean',
            description:
              'Run under a PTY so terminal prompts (host-key confirmations, credential asks) can be'
              + ' detected and answered instead of hanging. Without it a command runs with piped output; a plain sudo, doas'
              + ' or su that fails only for want of a terminal is run once more under a PTY (when the host has one) and the'
              + ' result says so; any other command that needed a terminal is not repeated and the result says to rerun it'
              + ' with interactive: true. Set false to keep the plain pipe path. PTY output merges stderr into stdout (result notes pty: true).',
          },
        },
        // cmd or cmd_base64 required, validated at runtime
      },
      minItems: 1,
    },
    parallel: {
      type: 'boolean',
      description: 'Run all commands in parallel. Default: false (sequential). A parallel run starts every command, so stop_on_error does not apply.',
    },
    working_dir: {
      type: 'string',
      description:
        'Global working directory applied to all commands unless overridden per-command.'
        + ' Optional, defaults to the session\'s working directory when omitted.'
        + ' A sandboxed command must use a directory inside the session\'s project root.',
    },
    timeout_ms: {
      type: 'integer',
      minimum: 0,
      description: 'Optional timeout in ms applied to all commands. Omitted or 0 waits for completion or cancellation.',
    },
    verbosity: {
      type: 'string',
      enum: ['count_only', 'minimal', 'standard', 'verbose'],
      description:
        'count_only: exit codes only (plus process_id, timed_out, cancelled, expectation_error, warnings and other notices that explain or act on the result);'
        + ' minimal: exit codes + first line stdout/stderr;'
        + ' standard: full stdout/stderr + exit code (default);'
        + ' verbose: everything + timing, env, cwd.',
    },
    stop_on_error: {
      type: 'boolean',
      description:
        'Sequential runs only (ignored with parallel: true): stop at the first failed command (non-zero exit, timed_out, or expectation_error).'
        + ' Unexecuted commands appear as {skipped: true} entries. Default: false.',
    },
    file_ops: {
      type: 'array',
      description:
        'File operations to execute BEFORE commands run, on the host and outside any sandbox. Every path, absolute or relative,'
        + ' must be inside the project root; delete refuses the root itself and .git. If one fails, the earlier ones stay applied'
        + ' (listed in the result), no commands run, and nothing is undone. Refused in sessions that require the exec boundary.',
      items: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['copy', 'move', 'delete'],
            description: 'Operation type.',
          },
          source: {
            type: 'string',
            description: 'Source path (relative or absolute), which must be inside the project root.',
          },
          destination: {
            type: 'string',
            description: 'Destination path. Required for copy and move.',
          },
          recursive: {
            type: 'boolean',
            description: 'Copy/delete directories recursively. Deleting a path that does not exist fails and names the path.',
          },
          overwrite: {
            type: 'boolean',
            description:
              'Overwrite destination if it already exists (copy/move only). Default: false. '
              + 'When false and destination exists, the operation returns an error.',
            default: false,
          },
          dry_run: {
            type: 'boolean',
            description:
              'Preview what would be deleted without deleting (delete only). Default: false. '
              + 'Returns a list of files that would be deleted.',
            default: false,
          },
          update_imports: {
            type: 'boolean',
            description:
              'After a move of a TypeScript/JavaScript file or of a directory, rewrite every relative import of a moved file (written with or without'
              + ' an extension, or as a directory index) in the files that import it, and re-base each moved file\'s own relative imports'
              + ' for its new directory. All moves of one call share one pass over the project. Non-relative imports (aliases, packages) are not touched.'
              + ' A warning says when nothing changed. Default: false.',
            default: false,
          },
        },
        required: ['op', 'source'],
      },
    },
  },
  required: ['commands'],
} as const;

// ─── TypeScript interfaces ────────────────────────────────────────────────────

export type ExecVerbosity = 'count_only' | 'minimal' | 'standard' | 'verbose';

export interface ExecExpect {
  exit_code?: number | undefined;
  stdout_contains?: string | undefined;
  stderr_contains?: string | undefined;
}

export interface ExecRetry {
  max?: number | undefined;
  delay_ms?: number | undefined;
  /** Max jitter cap for exponential backoff. Default: 30000. */
  max_delay_ms?: number | undefined;
  backoff?: 'fixed' | 'exponential' | undefined;
  /** Error categories to retry on. Default: ['network', 'lock', 'busy']. */
  on?: ReadonlyArray<'network' | 'lock' | 'busy' | 'oom'> | undefined;
}

export interface ExecUntil {
  pattern: string;
  timeout_ms?: number | undefined;
  kill_after?: boolean | undefined;
}

export interface ExecFileOp {
  op: 'copy' | 'move' | 'delete';
  source: string;
  destination?: string | undefined;
  recursive?: boolean | undefined;
  /** Overwrite destination if it exists (copy/move only). Default: false. */
  overwrite?: boolean | undefined;
  /** Preview what would be deleted without deleting (delete only). Default: false. */
  dry_run?: boolean | undefined;
  /** Rewrite TS/JS import paths after move (move only). Default: false. */
  update_imports?: boolean | undefined;
}

export interface ExecCommandInput {
  cmd?: string | undefined;
  cmd_base64?: string | undefined;
  cwd?: string | undefined;
  working_dir?: string | undefined;
  timeout_ms?: number | undefined;
  env?: Record<string, string> | undefined;
  expect?: ExecExpect | undefined;
  background?: boolean | undefined;
  retry?: ExecRetry | undefined;
  until?: ExecUntil | undefined;
  /**
   * Stream stdout to a pollable progress file. true creates it at start and
   * keeps it; unset (no timeout or timeout_ms > 30000) creates one only once
   * the run passes 30 s and removes it at the end; false never creates one.
   */
  progress?: boolean | undefined;
  /**
   * Run under a PTY with the prompt-answer path (see exec/interactive.ts).
   * true forces it (when the host has a PTY backend), false forces the plain
   * pipe path, undefined runs piped and reruns once under the PTY only when a
   * single plain sudo/doas/su failed for want of a terminal before running
   * anything (any other command is returned with the note to rerun it).
   */
  interactive?: boolean | undefined;
}

export interface ExecInput {
  commands: ExecCommandInput[];
  parallel?: boolean | undefined;
  working_dir?: string | undefined;
  timeout_ms?: number | undefined;
  verbosity?: ExecVerbosity | undefined;
  /** What an overflowing output shows: head and tail by arithmetic (default) or ranked by the decision model. */
  file_ops?: ExecFileOp[] | undefined;
  /**
   * Stop sequential execution on first failed command; a parallel run starts
   * every command and ignores it. Unexecuted commands appear as
   * {skipped: true} entries. Default: false.
   */
  fail_fast?: boolean | undefined;
  /** Alias for fail_fast. */
  stop_on_error?: boolean | undefined;
}

// ─── Result interfaces ────────────────────────────────────────────────────────

export interface ExecCommandResult {
  captured_exec_unsupported_options?: readonly string[] | undefined;
  captured_exec_availability?: CapturedExecAvailability | undefined;
  /** Captured exec only: the command's file changes were applied before its output was withheld. */
  captured_changes_published?: boolean | undefined;
  /**
   * Captured exec only: why the run's file changes were not applied (`conflict`, `alias`,
   * `reserved` or `authority`), the project path involved, and the full sentence with the next step.
   */
  captured_refusal?: { readonly kind: 'conflict' | 'alias' | 'reserved' | 'authority'; readonly path: string; readonly reason: string } | undefined;
  cmd: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
  /** Set when expectations are violated. */
  expectation_error?: string | undefined;
  /** Set when command exceeded timeout. */
  timed_out?: boolean | undefined;
  /** Set when an external AbortSignal cancelled the command (orchestration engine cancellation). Never combined with timed_out. */
  cancelled?: boolean | undefined;
  /** Set when command ran in background. */
  process_id?: string | undefined;
  pid?: number | undefined;
  /** Timing info (verbose only). */
  duration_ms?: number | undefined;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  /**
   * Credential-bearing environment variable NAMES withheld from the spawned
   * process by the exec env scrub (never values). Present only when at least one
   * variable was withheld, so a clean spawn stays quiet.
   */
  withheld_env?: string[] | undefined;
  /** Truncation note. */
  stdout_truncated?: boolean | undefined;
  stderr_truncated?: boolean | undefined;
  /** Number of retry attempts used. */
  retries?: number | undefined;
  /** Set when this command was not executed due to fail_fast/stop_on_error or a cancel. */
  skipped?: boolean | undefined;
  /** Why a skipped command did not run: `earlier command failed: <cmd>` or `cancelled`. */
  skipped_reason?: string | undefined;
  /**
   * Set when the guard refused the command before execution. Nothing ran, so
   * the reason is the whole result and reporting must not be shortened by
   * verbosity, see formatResult in exec/runtime.ts.
   */
  denied?: boolean | undefined;
  /** Structured denial: full reason plus the per-segment classification breakdown. */
  denial_detail?: Record<string, unknown> | undefined;
  /** Path to the pollable progress file when progress tracking is enabled. */
  progress_file?: string | undefined;
  /** Tool-level warnings for degraded command collection or side effects. */
  warnings?: string[] | undefined;
  /**
   * Whether this command ran inside the per-command OS sandbox boundary. Present
   * only when the sandbox was active for the run, so a non-sandboxed exec stays
   * quiet. False with a `sandbox_boundary` reason when the sandbox was requested
   * but the host could not provide it (honest-unavailable, ran unsandboxed).
   */
  sandboxed?: boolean | undefined;
  /** One-line summary of the boundary that was applied (or why there was none). */
  sandbox_boundary?: string | undefined;
  /** Network posture inside the boundary: disabled, enabled, or unconfirmed (unknown). */
  sandbox_network?: 'disabled' | 'enabled' | 'unknown' | undefined;
  /** Named host-access escalations granted to this sandboxed run (network, writable extras). */
  sandbox_escalations?: string[] | undefined;
  /**
   * One dense line naming the isolation that applied to this run, so an absence
   * observed inside the boundary is not read as an absence on the host.
   *
   * The boundary has a different world than the machine: a separate network
   * namespace (host `localhost` services, the goodvibes daemon among them, are
   * unreachable), a read-only filesystem outside the workspace, a masked /tmp
   * and $HOME, and narrower device and process visibility. Without this line a
   * missing `bluetoothctl` or an empty device list reads as fact about the
   * user's computer, which is how a sandboxed probe came to report that a
   * headset that was plugged in did not exist.
   */
  sandbox_note?: string | undefined;
  /**
   * Whether this command ran under the PTY prompt-answer path. Present only on
   * interactive runs; the PTY merges stderr into stdout, so `stdout` carries
   * the full terminal transcript and `stderr` is empty.
   */
  pty?: boolean | undefined;
  /** Number of terminal prompts answered through the approval machinery. */
  prompts_answered?: number | undefined;
  /**
   * The detected-but-unanswered terminal prompt at the moment the run ended
   * (timeout, decline, or cancellation), the honest diagnosis of what the
   * child was waiting on.
   */
  pending_prompt?: string | undefined;
  /** Set when the surfaced prompt ask was declined and the run was stopped. */
  prompt_declined?: boolean | undefined;
  /**
   * Answers that were typed but not sent because the program printed more
   * output before the answer arrived. The prompt is asked again.
   */
  prompts_dropped?: number | undefined;
  /**
   * Set on a non-PTY run whose command failed because it needed a controlling
   * terminal; says what to rerun it with.
   */
  tty_note?: string | undefined;
}

// BackgroundProcess is defined in shared/process-manager and re-exported here for consumers of this schema module.
export type { BackgroundProcess } from '../shared/process-manager.js';

// The one reading of an entry's command text, shared with the permission readers that judge it.
export { execCommandText } from '../../runtime/permissions/exec-command-text.js';

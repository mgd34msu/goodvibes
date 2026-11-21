/**
 * What a turn's tool calls changed, recorded as they settle, for its failure
 * reading (core/turn-failure.ts): the orchestrator's turns and the companion
 * chat's record the same facts the same way. Decided from what each tool
 * declares (its side effects and the arguments that name its paths); no
 * request, no I/O, a few in-memory additions per call.
 */
import { declaredValues } from '../gate/classify.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../types/tools.js';
import type { TurnChanges } from './turn-failure.js';

export class TurnChangeRecord {
  readonly #files = new Set<string>();
  #commands = 0;
  #messages = 0;
  #unknown = 0;

  /**
   * Record a settled batch. A call the gate let through counts whether or not
   * it succeeded, since a failed, timed-out or cancelled one may have changed
   * things before it stopped; only a call that never reached its tool is left
   * out (refused, held or skipped at the gate, arguments that could not be
   * read, no such tool, or an edit its matcher refused before writing).
   * A call to a tool that writes files adds the paths it names; a command
   * counts as run; a call that reaches another service with an effect there
   * (state and network: a message, an MCP call) counts as sent when it
   * succeeded and as unknown when it failed; a call to a tool that declares
   * nothing counts as unknown. Reads, fetches and GoodVibes' own bookkeeping
   * (plans, tasks) change nothing the person has to look at.
   */
  note(calls: readonly ToolCall[], results: readonly ToolResult[], definitionOf: (name: string) => ToolDefinition | undefined): void {
    for (const result of results) {
      const call = calls.find((candidate) => candidate.id === result.callId);
      if (!call) continue;
      const definition = definitionOf(call.name);
      if (!result.success && neverRan(result, call, definition)) continue;
      const effects = definition?.sideEffects;
      if (effects === undefined) { this.#unknown += 1; continue; }
      if (effects.includes('exec')) { this.#commands += 1; continue; }
      if (effects.includes('write_fs')) {
        const paths = declaredValues(call.arguments, definition?.subjects?.paths);
        if (paths && paths.length > 0) for (const path of paths) this.#files.add(path);
        else this.#unknown += 1;
        continue;
      }
      if (effects.includes('network') && effects.includes('state')) {
        if (result.success) this.#messages += 1;
        else this.#unknown += 1;
      }
    }
  }

  get changes(): TurnChanges {
    return { files: [...this.#files], commands: this.#commands, messages: this.#messages, unknown: this.#unknown };
  }
}

const NOT_RUN_DECISIONS: ReadonlySet<string> = new Set(['refused', 'queued-for-owner', 'skipped']);
const NOT_WRITTEN_EDITS: ReadonlySet<string> = new Set(['not_found', 'ambiguous', 'conflict']);

/** Whether a failed call never reached its tool, so it cannot have changed anything. */
function neverRan(result: ToolResult, call: ToolCall, definition: ToolDefinition | undefined): boolean {
  if (definition === undefined || call.argumentError !== undefined) return true;
  if (result.decision !== undefined && NOT_RUN_DECISIONS.has(result.decision.state)) return true;
  const edit = result.hostEvidence?.editStatus;
  return edit !== undefined && NOT_WRITTEN_EDITS.has(edit);
}

/**
 * The attempts made to the provider that failed last: each request counts;
 * an answer, or a request to another model, starts the count again.
 */
export class TurnAttemptRecord {
  #key: string | undefined;
  #times: number[] = [];

  /** A request is being sent to `model` (any stable key: provider and model). */
  sent(model: string, at: number): void {
    if (model !== this.#key) { this.#key = model; this.#times = []; }
    this.#times.push(at);
  }

  /** The provider answered: the requests so far did not fail. */
  answered(): void {
    this.#times = [];
  }

  get count(): number { return this.#times.length; }
  get times(): readonly number[] { return [...this.#times]; }
  get model(): string | undefined { return this.#key; }
}

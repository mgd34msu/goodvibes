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
   * Record a settled batch: a successful call to a tool that writes files adds
   * the paths it names; a command counts as run; a call that reaches another
   * service with an effect there (state and network: a message, an MCP call)
   * counts as sent; a call to a tool that declares nothing counts as unknown.
   * Reads, fetches and GoodVibes' own bookkeeping (plans, tasks) change nothing
   * the person has to look at.
   */
  note(calls: readonly ToolCall[], results: readonly ToolResult[], definitionOf: (name: string) => ToolDefinition | undefined): void {
    for (const result of results) {
      if (!result.success) continue;
      const call = calls.find((candidate) => candidate.id === result.callId);
      if (!call) continue;
      const definition = definitionOf(call.name);
      const effects = definition?.sideEffects;
      if (effects === undefined) { this.#unknown += 1; continue; }
      if (effects.includes('exec')) { this.#commands += 1; continue; }
      if (effects.includes('write_fs')) {
        const paths = declaredValues(call.arguments, definition?.subjects?.paths);
        if (paths && paths.length > 0) for (const path of paths) this.#files.add(path);
        else this.#unknown += 1;
        continue;
      }
      if (effects.includes('network') && effects.includes('state')) this.#messages += 1;
    }
  }

  get changes(): TurnChanges {
    return { files: [...this.#files], commands: this.#commands, messages: this.#messages, unknown: this.#unknown };
  }
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

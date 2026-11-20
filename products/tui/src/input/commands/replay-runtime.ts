import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { handleReplayCommand, replayLedgerOf } from '@goodvibes/engine/platform/platform/core';
import { defineCommand, defineList, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { doAction, listInput, readAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import { requireReplayEngine } from './runtime-services.ts';

const LOCAL = { terminalOnly: 'Recorded runs are kept by the terminal app.' } as const;

const RUNS = defineList<CommandContext>({
  name: 'replay.runs',
  async read(ctx) {
    let ledger: ReturnType<typeof replayLedgerOf>;
    try { ledger = replayLedgerOf(requireReplayEngine(ctx)); } catch { ledger = undefined; }
    return [...(ledger?.listRunIds() ?? [])].reverse().map((id): ListRow => ({ value: id, label: id }));
  },
  operator: LOCAL,
});

/** One replay step through the platform's handler; a step that did not happen is a refusal. */
async function replay(ctx: CommandContext, step: string, args: string[]): Promise<string> {
  const result = await handleReplayCommand({ replayEngine: requireReplayEngine(ctx) }, step, args);
  if (!result.ok) throw commandRefusal(result.output);
  return result.output;
}

export function registerReplayRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'replay',
    title: 'Replay recorded runs',
    summary: 'Every turn is recorded as a run: load one, step through it, compare it with another, and save the report',
    group: 'Sessions',
    report: 'status',
    actions: [
      readAction<CommandContext>({
        id: 'status', label: 'See the loaded run', word: 'status', readsOnlyThisMachine: true, operator: LOCAL,
        sentence: 'Shows which recorded run is loaded and where in it you are.',
        async run(_values, ctx) {
          const snap = requireReplayEngine(ctx).getSnapshot();
          return snap.status === 'idle'
            ? 'No run is loaded. /replay runs lists the recorded runs; /replay load loads one.'
            : `Loaded run: ${snap.runId} · rev ${snap.currentRev} of ${snap.totalRevisions} · ${snap.status}`;
        },
      }),
      readAction<CommandContext>({
        id: 'runs', label: 'See the recorded runs', word: 'runs', readsOnlyThisMachine: true, operator: LOCAL,
        sentence: 'Lists the runs recorded so far, one per turn.',
        async run(_values, ctx) { return replay(ctx, 'load', []); },
      }),
      doAction<CommandContext>({
        id: 'load', label: 'Load a recorded run', word: 'load', touches: 'reads', operator: LOCAL,
        inputs: [listInput({ id: 'run', label: 'Run', help: 'The recorded runs, newest first', list: RUNS, other: 'a run id' })],
        sentence: 'Run {run} is loaded for stepping through, from its first event.', example: { run: 'turn-1' },
        async run(values, ctx) { return replay(ctx, 'load', [values.run!]); },
      }),
      doAction<CommandContext>({
        id: 'step', label: 'Step through the loaded run', word: 'step', touches: 'reads', operator: LOCAL,
        inputs: [{ id: 'count', label: 'Steps', help: 'How many events to go forward', kind: 'number', freeTextReason: 'a whole number from 1', required: { default: '1', defaultMeans: 'one event' }, typed: { position: 1 } }],
        sentence: 'The loaded run goes forward by the number of events given, each one shown.', example: { count: '5' },
        async run(values, ctx) { return replay(ctx, 'step', [values.count || '1']); },
      }),
      doAction<CommandContext>({
        id: 'seek', label: 'Jump to a point in the loaded run', word: 'seek', touches: 'reads', operator: LOCAL,
        inputs: [{ id: 'rev', label: 'Revision', help: 'The event number to jump to; 0 is the start', kind: 'number', freeTextReason: 'a whole number from 0', required: true, typed: { position: 1 } }],
        sentence: 'The loaded run jumps to revision {rev}.', example: { rev: '12' },
        async run(values, ctx) { return replay(ctx, 'seek', [values.rev!]); },
      }),
      readAction<CommandContext>({
        id: 'diff', label: 'Compare the loaded run with another', word: 'diff', operator: LOCAL,
        inputs: [listInput({ id: 'run', label: 'Other run', help: 'The recorded runs, newest first', list: RUNS, other: 'a run id' })],
        sentence: 'Compares the loaded run with run {run}, event by event, and lists where they differ.', example: { run: 'turn-2' },
        async run(values, ctx) { return replay(ctx, 'diff', [values.run!]); },
      }),
      doAction<CommandContext>({
        id: 'export', label: 'Save the replay report to a file', word: 'export', operator: LOCAL,
        inputs: [textInput({ id: 'path', label: 'File', help: 'Where to write the JSON report', why: 'a file path', kind: 'path', typed: { position: 1 } })],
        sentence: 'The report of the loaded run, with every difference found, is written to {path}.', example: { path: 'replay-report.json' },
        async run(values, ctx) { return replay(ctx, 'export', [values.path!]); },
      }),
    ],
  }));
}

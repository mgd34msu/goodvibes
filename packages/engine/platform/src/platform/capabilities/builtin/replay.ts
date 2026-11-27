/**
 * Recorded runs (home `session`): every turn of the terminal app is recorded
 * as a run in the project (`<project>/.goodvibes/tui/replay/`), by the
 * program running the turn; loading one and stepping through it is that
 * program's own view state, so these run in the program holding the
 * conversation, with its replay engine handed in.
 */
import type { DeterministicReplayEngine } from '../../core/deterministic-replay.js';
import { handleReplayCommand, replayLedgerOf } from '../../core/replay-command-handler.js';
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';
import { callerPathOf } from '../path-inputs.js';

export interface ReplayCapabilityServices {
  /** This program's replay engine; absent in a program that records no runs (the Agent). */
  readonly replay?: { readonly engine: DeterministicReplayEngine } | undefined;
}

/** The recorded runs, newest first (terminal-shell's list reads them from `replay.runs`). */
export const REPLAY_RUNS_LIST = 'replay.runs' as ListName;

type Definition = CapabilityDefinition<ReplayCapabilityServices>;

function engineOf(services: ReplayCapabilityServices): DeterministicReplayEngine {
  if (!services.replay) throw new CapabilityRefusal('This program records no runs: recorded runs are kept by the terminal app.', 'Open the Work place in the terminal app.', 'UNAVAILABLE');
  return services.replay.engine;
}

async function step(services: ReplayCapabilityServices, word: string, args: string[]): Promise<string> {
  const result = await handleReplayCommand({ replayEngine: engineOf(services) }, word, args);
  if (!result.ok) throw new CapabilityRefusal(result.output);
  return result.output;
}

const RUN = (label: string): InputDescription => ({ id: 'run', label, help: 'The recorded runs, newest first', kind: 'choice', choices: { list: REPLAY_RUNS_LIST, allowOther: { reason: 'a run id' } }, required: true, typed: { position: 1 } });

function replayCapability(fields: Pick<Definition, 'actionId' | 'label' | 'sentence' | 'run'> & { readonly inputs?: Definition['inputs']; readonly example?: Definition['example']; readonly changes?: true }): Definition {
  return {
    capability: { id: `replay.${fields.actionId}`, group: 'work', home: 'session', repeat: 'safe' },
    actionId: fields.actionId, label: fields.label, word: fields.actionId, inputs: fields.inputs ?? [],
    sentence: fields.sentence, done: '', touches: fields.changes ? 'this-machine' : 'reads', lasts: 'not-a-change', risk: 'none', example: fields.example ?? {},
    run: fields.run,
  };
}

export const REPLAY_STATUS = replayCapability({
  actionId: 'status', label: 'See the loaded run',
  sentence: 'Shows which recorded run is loaded and where in it you are.',
  async run(_values, services) {
    const snap = engineOf(services).getSnapshot();
    return snap.status === 'idle'
      ? { text: 'No run is loaded. Load one from the recorded runs in the Work place.', data: { status: 'idle' } }
      : { text: `The turn of ${snap.runId} is loaded, at event ${snap.currentRev} of ${snap.totalRevisions}${snap.status === 'exhausted' ? ', its last' : ''}.`, data: { runId: snap.runId, rev: snap.currentRev, total: snap.totalRevisions, status: snap.status } };
  },
});

export const REPLAY_RUNS = replayCapability({
  actionId: 'runs', label: 'See the recorded runs',
  sentence: 'Lists the runs recorded so far, one per turn.',
  async run(_values, services) {
    const engine = engineOf(services);
    const runs = [...(replayLedgerOf(engine)?.listRunIds() ?? [])].reverse();
    return { text: await step(services, 'load', []), data: { runs, loaded: engine.getSnapshot().runId ?? null } };
  },
});

export const REPLAY_LOAD = replayCapability({
  actionId: 'load', label: 'Load a recorded run', inputs: [RUN('Run')], changes: true,
  sentence: 'Run {run} is loaded for stepping through, from its first event.', example: { run: 'turn-1' },
  async run(values, services) { return { text: await step(services, 'load', [values.run!]) }; },
});

export const REPLAY_STEP = replayCapability({
  actionId: 'step', label: 'Step through the loaded run', changes: true,
  inputs: [{ id: 'count', label: 'Steps', help: 'How many events to go forward', kind: 'number', freeTextReason: 'a whole number from 1', required: { default: '1', defaultMeans: 'one event' }, typed: { position: 1 } }],
  sentence: 'The loaded run goes forward by the number of events given, each one shown.', example: { count: '5' },
  async run(values, services) { return { text: await step(services, 'step', [values.count || '1']) }; },
});

export const REPLAY_SEEK = replayCapability({
  actionId: 'seek', label: 'Jump to a point in the loaded run', changes: true,
  inputs: [{ id: 'rev', label: 'Event', help: 'The event number to jump to; 0 is the start', kind: 'number', freeTextReason: 'a whole number from 0', required: true, typed: { position: 1 } }],
  sentence: 'The loaded run jumps to event {rev}.', example: { rev: '12' },
  async run(values, services) { return { text: await step(services, 'seek', [values.rev!]) }; },
});

export const REPLAY_DIFF = replayCapability({
  actionId: 'diff', label: 'Compare the loaded run with another', inputs: [RUN('Other run')],
  sentence: 'Compares the loaded run with run {run}, event by event, and lists where they differ.', example: { run: 'turn-2' },
  async run(values, services) { return { text: await step(services, 'diff', [values.run!]) }; },
});

export const REPLAY_EXPORT = replayCapability({
  actionId: 'export', label: 'Save the replay report to a file', changes: true,
  inputs: [{ id: 'path', label: 'File', help: 'Where to write the JSON report', kind: 'path', file: 'written', freeTextReason: 'a file path', required: true, typed: { position: 1 } }],
  sentence: 'The report of the loaded run, with every difference found, is written to {path}.', example: { path: 'replay-report.json' },
  // Placed by the one rule for every capability's path (capabilities/path-inputs.ts).
  async run(values, services, caller) { return { text: await step(services, 'export', [callerPathOf(caller, values.path!, { personPathAsTyped: true })]) }; },
});

export const REPLAY_CAPABILITIES: readonly Definition[] = [REPLAY_STATUS, REPLAY_RUNS, REPLAY_LOAD, REPLAY_STEP, REPLAY_SEEK, REPLAY_DIFF, REPLAY_EXPORT];

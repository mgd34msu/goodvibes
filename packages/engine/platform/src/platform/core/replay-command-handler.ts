/**
 * The recorded-run actions (builtin/replay.ts, the Recorded runs tab of the
 * Work place): load a run, step through it, jump to an event, compare it with
 * another run and save the report.
 *
 * The handler delegates to an injected `DeterministicReplayEngine`
 * and an optional ledger reader for run access and for the runtime state
 * snapshot stored when each run started.
 *
 * Returns the words a person reads.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeterministicReplayEngine } from './deterministic-replay.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { LocalLedgerExporter, type LedgerEntry } from '../runtime/telemetry/exporters/local-ledger.js';
import type { RuntimeStateSnapshot } from '../runtime/diagnostics/types.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { resolveAtRestPolicy } from '../runtime/at-rest-persistence.js';

/** What the replay actions read recorded runs from (a LocalLedgerExporter satisfies it). */
export interface ReplayLedgerReader {
  readRunEntries: (runId: string) => LedgerEntry[];
  listRunIds: () => string[];
  /** When each run started and how many events it holds, so a run is named by its time and not its id. */
  listRunStarts?: () => ReadonlyMap<string, { readonly startedAt: number; readonly events: number }>;
  /** The runtime state snapshot stored when the run started, or null if none was stored. */
  readRunSnapshot: (runId: string) => RuntimeStateSnapshot | null;
}

/** The ledger each replay engine reads from, bound where the runtime is composed. */
const ledgerOfEngine = new WeakMap<DeterministicReplayEngine, ReplayLedgerReader>();

/** Turn events recorded per run; the per-chunk text deltas are left out. */
const SKIPPED_TURN_EVENTS = new Set(['STREAM_DELTA']);
/** The events a turn ends with; a turn refused before it ran (context overflow, a duplicate submission) ends with PREFLIGHT_FAIL alone. */
const TURN_ENDS = new Set(['TURN_COMPLETED', 'TURN_ERROR', 'TURN_CANCEL', 'PREFLIGHT_FAIL']);
/** A turn this long is written out in parts, so a runaway turn does not hold its events in memory. */
const MAX_HELD_ENTRIES = 500;
/** Text kept per recorded field: enough for the outcome line and a value comparison. */
const MAX_RECORDED_TEXT = 500;

/**
 * What a recorded event keeps: what `/replay diff` compares (each top-level
 * key, and its value when it is text, a number or a flag) and the turn
 * summary reads (`turnId`, `reason`, `error`, the start of `response`). A
 * nested value keeps only its kind, so a large tool result or message list is
 * not serialized on every event.
 */
function recordedPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') kept[key] = value.length > MAX_RECORDED_TEXT ? value.slice(0, MAX_RECORDED_TEXT) : value;
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) kept[key] = value;
    else kept[key] = Array.isArray(value) ? [] : {};
  }
  return kept;
}

export interface ReplayRecording {
  readonly ledger: ReplayLedgerReader;
  /** Stop recording (unsubscribe); recorded runs stay readable. */
  stop(): void;
}

/**
 * Records every turn as a replayable run: the turn's events (without stream
 * deltas) and the tool and task events inside it are kept under the turn id,
 * and `/replay` on `replayEngine` reads that ledger. Cost: per event, a small
 * copy of its top-level fields in memory; per turn, one append of its lines
 * when it ends (or each `MAX_HELD_ENTRIES` events), nothing on a stream delta.
 * A turn still running is not in the ledger yet; `stop()` writes what is held.
 */
export function startReplayRecording(options: {
  readonly runtimeBus: Pick<RuntimeEventBus, 'onDomain'>;
  readonly replayEngine: DeterministicReplayEngine;
  /** Directory the run ledger lives in (created on start). */
  readonly directory: string;
  /** Reads the at-rest redaction and retention settings (`configManager.get`). */
  readonly readConfig?: ((key: string) => unknown) | undefined;
}): ReplayRecording {
  mkdirSync(options.directory, { recursive: true });
  const ledger = new LocalLedgerExporter({
    filePath: join(options.directory, 'spans.jsonl'),
    ledgerFilePath: join(options.directory, 'runs.jsonl'),
    atRestPolicy: resolveAtRestPolicy(options.readConfig),
  });
  ledgerOfEngine.set(options.replayEngine, ledger);
  const revisions = new Map<string, number>();
  const held = new Map<string, LedgerEntry[]>();
  let activeTurn: string | undefined;
  /** The turn that was active when each run was submitted, given back the attribution when that run ends first. */
  const activeBefore = new Map<string, string>();
  const writeHeld = (runId: string): void => {
    const entries = held.get(runId);
    held.delete(runId);
    if (entries !== undefined) ledger.recordEvents(entries);
  };
  const record = (runId: string, eventName: string, payload: unknown, ts: number): void => {
    const rev = (revisions.get(runId) ?? 0) + 1;
    revisions.set(runId, rev);
    const entries = held.get(runId) ?? [];
    if (entries.length === 0) held.set(runId, entries);
    entries.push({ runId, rev, eventName, payload: recordedPayload(payload), ts });
    if (entries.length >= MAX_HELD_ENTRIES) writeHeld(runId);
  };
  const offTurn = options.runtimeBus.onDomain('turn', (envelope) => {
    const payload = envelope.payload as { readonly type: string; readonly turnId?: string };
    if (SKIPPED_TURN_EVENTS.has(payload.type)) return;
    const runId = payload.turnId ?? envelope.turnId ?? activeTurn;
    if (!runId) return;
    if (payload.type === 'TURN_SUBMITTED') {
      if (activeTurn !== undefined && activeTurn !== runId) activeBefore.set(runId, activeTurn);
      activeTurn = runId;
    }
    record(runId, payload.type, payload, envelope.ts);
    if (TURN_ENDS.has(payload.type)) {
      writeHeld(runId);
      revisions.delete(runId);
      const earlier = activeBefore.get(runId);
      activeBefore.delete(runId);
      // A turn refused while another ran gives the attribution back to the one still running.
      if (activeTurn === runId) activeTurn = earlier !== undefined && revisions.has(earlier) ? earlier : undefined;
    }
  });
  const inTurn = (envelope: { readonly ts: number; readonly turnId?: string | undefined; readonly payload: unknown }): void => {
    const runId = envelope.turnId ?? activeTurn;
    if (!runId) return;
    record(runId, (envelope.payload as { readonly type: string }).type, envelope.payload, envelope.ts);
  };
  const offTools = options.runtimeBus.onDomain('tools', inTurn);
  const offTasks = options.runtimeBus.onDomain('tasks', inTurn);
  return {
    ledger,
    stop: () => {
      offTurn(); offTools(); offTasks();
      for (const runId of [...held.keys()]) writeHeld(runId);
    },
  };
}

/** The run ledger bound to this replay engine by `startReplayRecording`, if any. */
export function replayLedgerOf(engine: DeterministicReplayEngine): ReplayLedgerReader | undefined {
  return ledgerOfEngine.get(engine);
}

/** A recorded event's name as words ("TURN_SUBMITTED" is "turn submitted"). */
function eventWords(name: string): string {
  return name.replace(/[_.:-]+/g, ' ').trim().toLowerCase();
}


export interface ReplayCommandResult {
  /** Human-readable output to show the user. */
  output: string;
  /** Whether the command succeeded. */
  ok: boolean;
}

export interface ReplayCommandDeps {
  replayEngine: DeterministicReplayEngine;
}

/**
 * Dispatch a parsed /replay subcommand.
 *
 * @param subcommand - The first word after /replay (e.g. 'load', 'step').
 * @param args       - Remaining tokens.
 * @param explicitLedger - Ledger reader for 'load' and 'diff'; when omitted,
 *                     the one `startReplayRecording` bound to the engine.
 */
export async function handleReplayCommand(
  deps: ReplayCommandDeps,
  subcommand: string,
  args: string[],
  explicitLedger?: ReplayLedgerReader,
): Promise<ReplayCommandResult> {
  const engine = deps.replayEngine;
  const ledger = explicitLedger ?? replayLedgerOf(engine);

  switch (subcommand.toLowerCase()) {
    case 'load': {
      const runId = args[0]!;
      if (!runId) {
        // List available runs if no ledger argument.
        if (!ledger) {
          return {
            ok: false,
            output: 'Name the run to load. This program does not record runs, so there is nothing to list.',
          };
        }
        const ids = ledger.listRunIds();
        if (ids.length === 0) {
          return {
            ok: true,
            output: 'No recorded runs yet.\n\nEvery turn is recorded as a run once it starts; send a message, and it shows in Recorded runs, in the Work place.',
          };
        }
        const list = ids.map((id, i) => `  ${i + 1}. ${id}`).join('\n');
        return {
          ok: true,
          output: `Available runs (${ids.length}):\n${list}\n\nLoad one with Enter on it in Recorded runs, in the Work place.`,
        };
      }

      if (!ledger) {
        return {
          ok: false,
          output: `Cannot load run "${runId}": this runtime does not record runs, so there is nothing to load.`,
        };
      }

      const entries = ledger.readRunEntries(runId);
      if (entries.length === 0) {
        return {
          ok: false,
          output: `No ledger entries found for run "${runId}".\n\nRecorded runs, in the Work place, lists the runs there are.`,
        };
      }

      // The baseline is the runtime state snapshot stored when the run started.
      // A run recorded before snapshots were stored has none; it replays from
      // an empty-domain baseline stamped with its first event's time, and the
      // output says so.
      const storedSnapshot = ledger.readRunSnapshot(runId);
      const baseline: RuntimeStateSnapshot = storedSnapshot ?? {
        capturedAt: entries[0]?.ts ?? Date.now(),
        domains: [],
      };

      engine.load(runId, baseline, entries);
      logger.info('[ReplayCommandHandler] run loaded', {
        runId,
        events: entries.length,
        storedSnapshot: storedSnapshot !== null,
      });

      // At-rest redaction runs at write time, so a recorded run may already carry
      // [REDACTED_*] markers where a secret was masked. Surface that honestly so a
      // viewer reads a marker as "redacted here", never as missing or corrupt data.
      const redacted = entries.some((entry) => JSON.stringify(entry.payload ?? '').includes('[REDACTED'));

      return {
        ok: true,
        output: [
          ((first, last) => `Loaded the turn of ${runId}: ${entries.length} event${entries.length === 1 ? '' : 's'}, ${first === last ? `at ${first}` : `from ${first} to ${last}`}.`)(
            new Date(entries[0]?.ts ?? Date.now()).toLocaleString(), new Date(entries[entries.length - 1]?.ts ?? Date.now()).toLocaleString()),
          storedSnapshot
            ? 'It starts from the state saved when the run began.'
            : 'It starts from an empty state: none was saved when this run began.',
          ...(redacted
            ? ['Some records had secrets masked when they were saved; they show as [REDACTED_*] markers, not as missing data.']
            : []),
          'In Recorded runs, in the Work place: step through it, jump to an event, or compare it with another run.',
        ].join('\n'),
      };
    }

    case 'step': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Load one first: Enter on it in Recorded runs, in the Work place.',
        };
      }
      if (snap.status === 'exhausted') {
        return {
          ok: true,
          output: `This run is at its end, event ${snap.currentRev} of ${snap.totalRevisions}. Jump to an earlier event to go on.`,
        };
      }

      const n = args[0]! ? parseInt(args[0]!, 10) : 1;
      if (isNaN(n) || n < 1) {
        return {
          ok: false,
          output: `"${args[0]!}" is not a number of steps: give a whole number from 1.`,
        };
      }

      const stepped = engine.step(n);
      const after = engine.getSnapshot();

      if (stepped.length === 0) {
        return {
          ok: true,
          output: `Nothing to step: the run is already at event ${after.currentRev} of ${after.totalRevisions}.`,
        };
      }

      const said = (frame: (typeof stepped)[number]): string => frame.entry?.eventName ? eventWords(frame.entry.eventName) : 'the state at the start';
      const lines: string[] = stepped.length === 1
        ? [`Went forward to event ${after.currentRev} of ${after.totalRevisions}: ${said(stepped[0]!)}.`]
        : [
          `Went forward ${stepped.length} events, to event ${after.currentRev} of ${after.totalRevisions}:`,
          ...stepped.map((frame) => `  event ${frame.rev}: ${said(frame)}`),
        ];
      if (after.status === 'exhausted') {
        lines.push('That was the last event of the run.');
      }

      return { ok: true, output: lines.join('\n') };
    }

    case 'seek': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Load one first: Enter on it in Recorded runs, in the Work place.',
        };
      }

      const rev = args[0]! ? parseInt(args[0]!, 10) : NaN;
      if (isNaN(rev) || rev < 0) {
        return {
          ok: false,
          output: `Give an event number from 0 to ${snap.totalRevisions}.`,
        };
      }

      engine.seek(rev);
      const after = engine.getSnapshot();
      const frame = after.currentFrame;
      const eventLabel = frame?.entry?.eventName ? eventWords(frame.entry.eventName) : 'the state at the start';

      return {
        ok: true,
        output: `Now at event ${after.currentRev} of ${after.totalRevisions}: ${eventLabel}.`,
      };
    }

    case 'diff': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Load one first: Enter on it in Recorded runs, in the Work place.',
        };
      }

      const otherRunId = args[0];
      if (!otherRunId) {
        return {
          ok: false,
          output: `Name the run to compare the loaded run "${snap.runId}" with, event by event; Recorded runs, in the Work place, lists them.`,
        };
      }
      if (otherRunId === snap.runId) {
        return {
          ok: false,
          output: `Run "${otherRunId}" is the loaded run; nothing was compared. Name a different recorded run (Recorded runs, in the Work place, lists them).`,
        };
      }
      if (!ledger) {
        return {
          ok: false,
          output: `Cannot compare with run "${otherRunId}": this session has no run ledger to read it from; nothing was compared.`,
        };
      }
      const otherEntries = ledger.readRunEntries(otherRunId);
      if (otherEntries.length === 0) {
        return {
          ok: false,
          output: `No ledger entries found for run "${otherRunId}"; nothing was compared.\n\nRecorded runs, in the Work place, lists the runs there are.`,
        };
      }

      const mismatches = engine.diff(otherEntries, { runId: otherRunId });

      if (mismatches.length === 0) {
        return {
          ok: true,
          output: `The loaded run and the other match: the same ${snap.totalRevisions} event${snap.totalRevisions === 1 ? '' : 's'} in the same order, with the same fields and turn endings.`,
        };
      }

      // Two turns always carry different turn ids, so those differences say nothing and are left to the saved report.
      const told = mismatches.filter((m) => !/field "turnId" value differs/.test(m.description));
      const idsOnly = mismatches.length - told.length;
      if (told.length === 0) {
        return {
          ok: true,
          output: `The loaded run and the other differ only in their turn ids (${idsOnly} event${idsOnly === 1 ? '' : 's'}); everything else matches.`,
        };
      }
      // Each difference in words: "Event 2, preflight ok: ..." (the kinds and domains are in the saved report).
      const lines: string[] = [
        `The loaded run and the other differ in ${told.length} place${told.length === 1 ? '' : 's'}${idsOnly > 0 ? `, besides their turn ids` : ''}:`,
      ];
      for (const m of told) {
        lines.push(`  ${m.description
          .replace(/^Rev (\d+)(?: "([^"]+)")?:?/, (_all, rev: string, name?: string) => `Event ${rev}${name ? `, ${eventWords(name)}` : ''}:`)
          // "Recorded" is the loaded run and "Replayed" the one compared with it.
          .replace(/field "([^"]+)" value differs\. Recorded: (.*)\. Replayed: (.*)\.$/, 'field "$1" differs: "$2" in the loaded run, "$3" in the other.')
          .replace(/\(recorded: ([^,]+), replayed: ([^)]+)\)/, '($1 in the loaded run, $2 in the other)')}`);
      }
      lines.push('Save the full report from Recorded runs, in the Work place ("save the report").');

      return { ok: true, output: lines.join('\n') };
    }

    case 'export': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Load one first: Enter on it in Recorded runs, in the Work place.',
        };
      }

      const filePath = args[0]!;
      if (!filePath) {
        return {
          ok: false,
          output: 'Name the file to write the report to, such as replay-report.json.',
        };
      }

      try {
        // A folder named in the path that is not there yet is made, as any other save does.
        mkdirSync(dirname(filePath), { recursive: true });
        await engine.export(filePath);
      } catch (err: unknown) {
        logger.warn('[ReplayCommandHandler] export failed', { filePath, err: summarizeError(err) });
        return {
          ok: false,
          output: `The report was not saved to ${filePath}: ${summarizeError(err)}.`,
        };
      }
      logger.info('[ReplayCommandHandler] export written', { filePath, runId: snap.runId });

      return {
        ok: true,
        output: `Saved the report of the loaded run to ${filePath}: ${snap.totalRevisions} event${snap.totalRevisions === 1 ? '' : 's'}, ${snap.mismatches.length} difference${snap.mismatches.length === 1 ? '' : 's'} found.`,
      };
    }

    default: {
      const snap = engine.getSnapshot();
      const statusLine = snap.status === 'idle'
        ? 'No run loaded.'
        : `Run ${snap.runId} is loaded, at event ${snap.currentRev} of ${snap.totalRevisions}.`;

      return {
        ok: false,
        output: [
          `"${subcommand}" is not something a recorded run does.`,
          '',
          'Recorded runs, in the Work place, lists the runs, loads one, steps through it, jumps to an event, compares two and saves the report.',
          '',
          statusLine,
        ].join('\n'),
      };
    }
  }
}

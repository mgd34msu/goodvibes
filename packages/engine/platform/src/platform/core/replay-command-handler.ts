/**
 * /replay command handler.
 *
 * Handles the subcommands of the /replay slash command:
 *   /replay runs            , list the recorded runs
 *   /replay load <runId>    , load a recorded run by ID
 *   /replay step [n]        , advance n steps (default 1)
 *   /replay seek <rev>      , jump to a specific revision
 *   /replay diff <runId>    , compare the loaded run with another recorded run
 *   /replay export <path>   , export replay report to a JSON file
 *
 * The handler delegates to an injected `DeterministicReplayEngine`
 * and an optional ledger reader for run access and for the runtime state
 * snapshot stored when each run started.
 *
 * Returns a human-readable result string to display in the conversation.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DeterministicReplayEngine } from './deterministic-replay.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { LocalLedgerExporter, type LedgerEntry } from '../runtime/telemetry/exporters/local-ledger.js';
import type { RuntimeStateSnapshot } from '../runtime/diagnostics/types.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { resolveAtRestPolicy } from '../runtime/at-rest-persistence.js';

/** What /replay reads recorded runs from (a LocalLedgerExporter satisfies it). */
export interface ReplayLedgerReader {
  readRunEntries: (runId: string) => LedgerEntry[];
  listRunIds: () => string[];
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
            output: 'Usage: /replay load <runId>\n\nThis runtime does not record runs, so there is nothing to list.',
          };
        }
        const ids = ledger.listRunIds();
        if (ids.length === 0) {
          return {
            ok: true,
            output: 'No recorded runs yet.\n\nEvery turn is recorded as a run once it starts; send a message, then run /replay runs again.',
          };
        }
        const list = ids.map((id, i) => `  ${i + 1}. ${id}`).join('\n');
        return {
          ok: true,
          output: `Available runs (${ids.length}):\n${list}\n\nUse /replay load <runId> to load a run.`,
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
          output: `No ledger entries found for run "${runId}".\n\n/replay runs lists the recorded runs.`,
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
          `Run "${runId}" loaded.`,
          `  Events: ${entries.length}`,
          `  First: ${new Date(entries[0]?.ts ?? Date.now()).toISOString()}`,
          `  Last:  ${new Date(entries[entries.length - 1]?.ts ?? Date.now()).toISOString()}`,
          storedSnapshot
            ? `  Baseline: state snapshot from run start (${storedSnapshot.domains.length} domain${storedSnapshot.domains.length === 1 ? '' : 's'}, ${new Date(storedSnapshot.capturedAt).toISOString()})`
            : '  Baseline: empty (no runtime state snapshot was stored when this run started)',
          ...(redacted
            ? ['', 'Note: some records were redacted at rest, secrets appear as [REDACTED_*] markers; the content shown is post-redaction.']
            : []),
          '',
          'Use /replay step to advance, /replay seek <rev> to jump, /replay diff <runId> to compare with another run.',
        ].join('\n'),
      };
    }

    case 'step': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Use /replay load <runId> first.',
        };
      }
      if (snap.status === 'exhausted') {
        return {
          ok: true,
          output: `Replay exhausted at rev ${snap.currentRev} / ${snap.totalRevisions}. Use /replay seek to reposition.`,
        };
      }

      const n = args[0]! ? parseInt(args[0]!, 10) : 1;
      if (isNaN(n) || n < 1) {
        return {
          ok: false,
          output: `Invalid step count "${args[0]!}". Must be a positive integer.`,
        };
      }

      const stepped = engine.step(n);
      const after = engine.getSnapshot();

      if (stepped.length === 0) {
        return {
          ok: true,
          output: `No steps taken. Already at rev ${after.currentRev} / ${after.totalRevisions}.`,
        };
      }

      const lines: string[] = [
        `Stepped ${stepped.length} event${stepped.length === 1 ? '' : 's'} (rev ${after.currentRev} / ${after.totalRevisions}).`,
      ];
      for (const frame of stepped) {
        const eventName = frame.entry?.eventName ?? 'snapshot';
        lines.push(`  [rev ${frame.rev}] ${eventName}`);
      }
      if (after.status === 'exhausted') {
        lines.push('\nReplay exhausted - all events have been replayed.');
      }

      return { ok: true, output: lines.join('\n') };
    }

    case 'seek': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Use /replay load <runId> first.',
        };
      }

      const rev = args[0]! ? parseInt(args[0]!, 10) : NaN;
      if (isNaN(rev) || rev < 0) {
        return {
          ok: false,
          output: `Usage: /replay seek <rev>\nValid range: 0 - ${snap.totalRevisions}.`,
        };
      }

      engine.seek(rev);
      const after = engine.getSnapshot();
      const frame = after.currentFrame;
      const eventLabel = frame?.entry?.eventName ? `event "${frame.entry.eventName}"` : 'initial snapshot';

      return {
        ok: true,
        output: `Seeked to rev ${after.currentRev} / ${after.totalRevisions} (${eventLabel}).`,
      };
    }

    case 'diff': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Use /replay load <runId> first.',
        };
      }

      const otherRunId = args[0];
      if (!otherRunId) {
        return {
          ok: false,
          output: `Usage: /replay diff <runId>\n\nCompares the loaded run "${snap.runId}" with another recorded run, event by event. /replay runs lists the recorded runs.`,
        };
      }
      if (otherRunId === snap.runId) {
        return {
          ok: false,
          output: `Run "${otherRunId}" is the loaded run; nothing was compared. Name a different recorded run (/replay runs lists them).`,
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
          output: `No ledger entries found for run "${otherRunId}"; nothing was compared.\n\n/replay runs lists the recorded runs.`,
        };
      }

      const mismatches = engine.diff(otherEntries, { runId: otherRunId });

      if (mismatches.length === 0) {
        return {
          ok: true,
          output: `Runs "${snap.runId}" and "${otherRunId}" match: the same ${snap.totalRevisions} event${snap.totalRevisions === 1 ? '' : 's'} in the same order, with the same payload fields and turn outcomes.`,
        };
      }

      const lines: string[] = [
        `Compared run "${snap.runId}" with "${otherRunId}": ${mismatches.length} difference${mismatches.length === 1 ? '' : 's'} found.`,
        '',
      ];
      for (const m of mismatches) {
        const tagParts = [m.kind, m.failureMode, m.ownerDomain].filter(Boolean);
        const tag = `[${tagParts.join('/')}]`.padEnd(40);
        lines.push(`  ${tag} ${m.description}`);
      }
      lines.push('');
      lines.push('Use /replay export <path> to write the full report.');

      return { ok: true, output: lines.join('\n') };
    }

    case 'export': {
      const snap = engine.getSnapshot();
      if (snap.status === 'idle') {
        return {
          ok: false,
          output: 'No run loaded. Use /replay load <runId> first.',
        };
      }

      const filePath = args[0]!;
      if (!filePath) {
        return {
          ok: false,
          output: 'Usage: /replay export <path>\n\nExample: /replay export replay-report.json',
        };
      }

      try {
        await engine.export(filePath);
      } catch (err: unknown) {
        logger.warn('[ReplayCommandHandler] export failed', { filePath, err: summarizeError(err) });
        return {
          ok: false,
          output: `Report export failed, no file was written: ${summarizeError(err)}\n  Path: ${filePath}\n  Use a path inside the project directory or the temp directory.`,
        };
      }
      logger.info('[ReplayCommandHandler] export written', { filePath, runId: snap.runId });

      return {
        ok: true,
        output: `Report exported: ${filePath}\n  Run: ${snap.runId}\n  Revisions: ${snap.totalRevisions}\n  Mismatches: ${snap.mismatches.length}`,
      };
    }

    default: {
      const snap = engine.getSnapshot();
      const statusLine = snap.status === 'idle'
        ? 'No run loaded.'
        : `Current run: ${snap.runId} | rev ${snap.currentRev} / ${snap.totalRevisions} | status: ${snap.status}`;

      return {
        ok: false,
        output: [
          `Unknown /replay subcommand: '${subcommand}'.`,
          '',
          'Available commands:',
          '  /replay runs              - list the recorded runs',
          '  /replay load <runId>      - load a recorded run',
          '  /replay step [n]          - advance n steps (default 1)',
          '  /replay seek <rev>        - jump to a specific revision',
          '  /replay diff <runId>      - compare the loaded run with another recorded run',
          '  /replay export <path>     - export report to JSON file',
          '',
          statusLine,
        ].join('\n'),
      };
    }
  }
}

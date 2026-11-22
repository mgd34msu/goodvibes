// Proves: A decision log written by 3.4.2 (schema 5) reads back every entry, with its questions, answers and notes, exactly as it was, after it is carried forward to schema 6 and after pruning removes other entries.
// Red when: The carry-forward moves a row's questions out without writing them to the questions table, or pruning deletes a question set another remaining entry still names, so the owner's record of what the decision model was asked is gone for good.
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog } from '../src/index.ts';

/** The decisions file exactly as 3.4.2 created it (schema 5): the whole entry, questions included, in each row. */
const SCHEMA_5 = `
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  entry TEXT NOT NULL,
  at TEXT GENERATED ALWAYS AS (json_extract(entry, '$.at')) VIRTUAL,
  status TEXT GENERATED ALWAYS AS (json_extract(entry, '$.status')) VIRTUAL,
  battery TEXT GENERATED ALWAYS AS (json_extract(entry, '$.context.battery')) VIRTUAL,
  site TEXT GENERATED ALWAYS AS (json_extract(entry, '$.context.site')) VIRTUAL
);
CREATE INDEX decisions_battery_at ON decisions (battery, at);
CREATE INDEX decisions_site_at ON decisions (site, at);
CREATE INDEX decisions_at ON decisions (at);
CREATE TABLE decision_notes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  kind TEXT NOT NULL CHECK (kind IN ('readings', 'action', 'truth')),
  payload TEXT NOT NULL,
  at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX decision_notes_decision_seq ON decision_notes (decision_id, seq);
PRAGMA user_version = 5;
`;

const gateQuestions = { network: { type: 'noul', question: 'Does `command` reach the network?' } };
const answered = (id: string, at: string, command: string, truth: boolean) => ({
  id,
  entry: { at, context: { battery: 'engine.gate.exec', site: 'gate.exec', version: 3 }, requestedModel: 'jev-latest', stateHash: `hash-${id}`,
    questions: gateQuestions, latencyMs: 210, requestId: `req-${id}`, status: 'answered', model: 'jev-1.13', answers: { network: { type: 'noul', noul: 0.91 } },
    usage: { inputTokens: 120, outputTokens: 3 }, lineage: { logicalRequestId: `logical-${id}`, attempts: [{ endpointIndex: 0, outcome: 'answered', dispatched: true }] } },
  notes: [
    { kind: 'readings', payload: JSON.stringify({ network: { verdict: 'yes', outcome: 'act', command } }) },
    { kind: 'action', payload: 'Ask the owner.' },
    ...(truth ? [{ kind: 'truth', payload: JSON.stringify({ source: 'owner', checks: [{ item: 'network', expected: 'yes', signal: 0.91, outcome: 'act', correct: true }] }) }] : []),
  ],
});
const ROWS = [
  answered('d-older', '2026-10-24T09:00:00.000Z', 'curl example.test', false),
  { id: 'd-failed', entry: { at: '2026-11-20T10:00:00.000Z', context: { battery: 'contract.check.unit-judge', site: 'contract.check' }, requestedModel: 'jev-latest',
    questions: { criterion_0: { type: 'noul', question: 'Is the report complete?' } }, latencyMs: 40, requestId: undefined, status: 'failed',
    error: { kind: 'context-limit', message: 'The judgment request exceeds the endpoint token limit.' } }, notes: [] },
  answered('d-newer', '2026-11-21T12:00:00.000Z', 'git push', true),
];
/** What the 3.4.2 build read back for a row: the stored entry with its id, and its notes in order (none on a failed entry). */
const asRead = (row: typeof ROWS[number]) => {
  const entry: Record<string, unknown> = { ...(JSON.parse(JSON.stringify(row.entry)) as Record<string, unknown>), id: row.id };
  if (entry['status'] === 'failed') return entry;
  return { ...entry, notes: row.notes.map((note) => note.kind === 'action' ? { kind: 'action', action: note.payload } : { kind: note.kind, [note.kind]: JSON.parse(note.payload) }) };
};

describe('the decision log carried from schema 5 to 6', () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { for (const step of cleanup.splice(0)) step(); });

  test('every entry of a 3.4.2 log reads back identical after the carry-forward, a reopen and a prune of another entry that shared its questions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'decision-log-carry-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'decisions.sqlite');
    const old = new Database(path, { create: true, strict: true });
    old.exec(SCHEMA_5);
    for (const row of ROWS) {
      old.query('INSERT INTO decisions (id, entry) VALUES ($id, $entry)').run({ id: row.id, entry: JSON.stringify(row.entry) });
      for (const note of row.notes) old.query('INSERT INTO decision_notes (decision_id, kind, payload) VALUES ($id, $kind, $payload)').run({ id: row.id, ...note });
    }
    old.close();

    {
      using log = new SqliteDecisionLog(path);
      expect(log.storage().rowsToCarry).toBe(ROWS.length);
      while (log.carryForward(1) > 0) { /* one row per batch, as the retention pass carries a large file */ }
      log.finishCarryForward();
      // Control: every row now names its questions by key, so the reads below come through the questions table.
      expect(log.storage().rowsToCarry).toBe(0);
      for (const row of ROWS) expect(log.get(row.id)).toEqual(asRead(row) as never);
    }

    using reopened = new SqliteDecisionLog(path);
    for (const row of ROWS) expect(reopened.get(row.id)).toEqual(asRead(row) as never);
    // The older gate decision ages out; the newer one asked the same questions and keeps them.
    expect(reopened.prune({ before: '2026-11-01T00:00:00.000Z', maxEntries: 1000, batch: 10 })).toBe(1);
    expect(reopened.get('d-older')).toBeUndefined();
    expect(reopened.get('d-newer')).toEqual(asRead(ROWS[2]!) as never);
    expect(reopened.get('d-failed')).toEqual(asRead(ROWS[1]!) as never);
  });
});

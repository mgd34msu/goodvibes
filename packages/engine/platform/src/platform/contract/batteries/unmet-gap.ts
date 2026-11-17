/**
 * `contract.unmet-gap`: what kind of evidence is missing for one criterion the
 * check read as unmet or not shown. One choice per such criterion, asked
 * concurrently while the nudge is built, so the nudge can say why the
 * criterion still reads that way instead of only listing it. State:
 * `{ goal, criterion, output, evidence }`: the worker's report and what the host
 * observed (changed files, commands, gates).
 *
 * Band: low stakes. The reading only explains a nudge; it never decides whether
 * work passes, and a nudge without it is complete.
 */
import { defineBattery, oneOf, STAKES_BANDS } from '@goodvibes-jev/judgment';

export const UNMET_GAPS = ['not_attempted', 'not_demonstrated', 'partial', 'contradicted'] as const;
export type UnmetGap = (typeof UNMET_GAPS)[number];

const GAP_OPTIONS = {
  not_attempted: 'Nothing in `output` or `evidence` is work toward `criterion`: the report does not claim it, and no change or command addresses it (changes made for other things do not count)',
  not_demonstrated: 'The report claims `criterion` is done, or a change addresses it, but no command output, test run or lines read show that the required behaviour holds',
  partial: '`output` or `evidence` shows that part of what `criterion` requires holds and the rest is missing, for example only some of the required cases, items or rows',
  contradicted: '`output` or `evidence` shows a result opposite to what `criterion` asks: a failure, an error exit or a wrong value. A count short of what is required is partial, not contradicted',
} as const satisfies Readonly<Record<UnmetGap, string>>;

/** The one sentence a nudge prints for each gap, in the worker's terms. */
export const UNMET_GAP_SENTENCES: Readonly<Record<UnmetGap, string>> = {
  not_attempted: 'nothing in your report or your changes shows any work toward this.',
  not_demonstrated: 'it may be done, but no changed file, command output or lines you read show that it holds.',
  partial: 'only part of it is shown; the rest is missing.',
  contradicted: 'what your report or your changes show conflicts with it.',
};

const PARSER_GOAL = 'The CSV parser handles quoted fields';

export const unmetGap = defineBattery({
  name: 'contract.unmet-gap',
  version: 2,
  description: 'What evidence is missing for one acceptance criterion the work does not yet show met: no attempt, nothing demonstrating it, only part of it, or something that conflicts with it.',
  accuracyFloor: 0.8,
  items: {
    gap: oneOf(
      'What is missing for `output` and `evidence` to show that `criterion` is met, given `goal`?',
      GAP_OPTIONS,
      STAKES_BANDS.low.confidence,
    ),
  },
  fixtures: [
    {
      name: 'the report never mentions the criterion and nothing changed for it',
      state: { goal: PARSER_GOAL, criterion: 'A quoted field may contain a comma', output: 'I renamed the parse function to parseCsv.', evidence: { changedFiles: ['src/csv.ts (rename only)'], commands: [] } },
      expect: { gap: 'not_attempted' },
    },
    {
      name: 'no work toward a stated flag',
      state: { goal: 'The export command writes orders to orders.csv', criterion: 'export --since <date> writes only newer orders', output: 'The export command now writes a header row to orders.csv.', evidence: { changedFiles: ['src/export.ts'], commands: ['bun test export (passed)'] } },
      expect: { gap: 'not_attempted' },
    },
    {
      name: 'the report says done but nothing shows it',
      state: { goal: PARSER_GOAL, criterion: 'Escaped quotes inside a quoted field are unescaped', output: 'Escaped quotes are handled correctly now.', evidence: { changedFiles: [], commands: [] } },
      expect: { gap: 'not_demonstrated' },
    },
    {
      name: 'a change exists but no run proves the behaviour',
      state: { goal: 'The server serves ./public on port 8080', criterion: 'The server starts and accepts connections on port 8080', output: 'I wired the listener to port 8080.', evidence: { changedFiles: ['src/server.ts'], commands: [] } },
      expect: { gap: 'not_demonstrated' },
    },
    {
      name: 'one of two required behaviours is shown',
      state: { goal: PARSER_GOAL, criterion: 'Quoted fields may contain commas and line breaks', output: 'Commas inside quotes now work; test passes.', evidence: { changedFiles: ['src/csv.ts', 'test/csv.test.ts'], commands: ['bun test csv (passed: commas in quotes)'] } },
      expect: { gap: 'partial' },
    },
    {
      name: 'the export covers only some orders',
      state: { goal: 'The export command writes every order to orders.csv', criterion: 'orders.csv holds one row per order', output: 'Exported the open orders.', evidence: { changedFiles: ['src/export.ts'], commands: ['orders export (wrote 12 rows; 40 orders exist)'] } },
      expect: { gap: 'partial' },
    },
    {
      name: 'the output shows the opposite',
      state: { goal: 'The backup command copies the database into backups/', criterion: 'Running `backup` exits with status 0', output: 'Ran backup; it printed the copy path.', evidence: { changedFiles: ['src/backup.ts'], commands: ['backup (exit status 1: permission denied)'] } },
      expect: { gap: 'contradicted' },
    },
    {
      name: 'a changed test now expects the wrong value',
      state: { goal: PARSER_GOAL, criterion: 'Empty fields parse as empty strings', output: 'Updated the test for empty fields.', evidence: { changedFiles: ['test/csv.test.ts (expects null for an empty field)'], commands: [] } },
      expect: { gap: 'contradicted' },
    },
  ],
});

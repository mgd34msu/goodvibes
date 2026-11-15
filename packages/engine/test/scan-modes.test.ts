import { fakePort, noulAnswer, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
/**
 * scan-modes coverage, security, permissions, env audit, test find and
 * dead_code modes
 *
 * Tests:
 * 1. security mode reads only the candidate lines code chooses, each once,
 *    with a few lines around it, and sends nothing for clean code
 * 2. a placeholder Jev dismisses is counted, not reported; an uncertain
 *    reading is reported as needing review
 * 3. permissions mode reads only call-shaped lines, reports risky calls with
 *    Jev's severity and dismisses lookalikes; with decision models off the
 *    candidates are listed unassessed
 * 5. env_audit compares against the template Jev picks, or compares nothing
 * 6. test_find picks the test among the files importing the source
 * 7. dead_code mode flags an unreferenced exported function (positive)
 * 8. dead_code mode does NOT flag a referenced exported function (negative)
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { chmodSync } from 'node:fs';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPermissions, runSecurity, runDeadCode, runEnvAudit, runTestFind } from '../platform/src/platform/tools/analyze/scan-modes.js';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { TEST_CANDIDATES_PER_READING } from '../platform/src/platform/tools/batteries/test-of-source.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

// Code chooses the candidate lines; Jev reads each candidate. These fakes stand
// in for it: a candidate no entry names reads as not a secret and not risky.
const LIVE_KEY = ['sk', 'live', 'Zx81Qm4Lk9vRtY7uPzA3bN6cW0'].join('_');
// Readings are anchored on the state's `line` field, since a line's state also
// carries its neighbours.
const readings = useToolReadings([
  ['"line":"const apiSecret', { realSecret: true }],
  [`"line":"export const STRIPE_KEY`, { realSecret: true }],
  ['"line":"const opaqueValue_apiKey', { realSecret: 'uncertain' }],
  ['"line":"app.post(', { risky: true, severity: 'high' }],
  ['"line":"function render(el, comment)', { risky: true, severity: 'medium' }],
  ['"line":"fs.chmodSync(', { risky: true, severity: 'high' }],
  ['"id":".env.example"', { fill: '.env.example' }],
  ['"id":"test/cart-totals.test.ts"', { fill: 'test/cart-totals.test.ts' }],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeFixtureDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gv-scan-modes-'));
}

async function writeFixture(dir: string, filename: string, content: string): Promise<string> {
  const filePath = join(dir, filename);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ---------------------------------------------------------------------------
// security mode
// ---------------------------------------------------------------------------

describe('runSecurity: security mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('reports a candidate line Jev reads as a real secret, one reading per candidate', async () => {
    await writeFixture(tmpDir, 'config.ts', `// Service configuration\nconst apiSecret = 'supersecretvalue123';\n`);

    const result = await runSecurity({ mode: 'security', securityScope: 'secrets', projectRoot: tmpDir }, tmpDir);

    const secrets = result.secrets as { findings: Array<{ file: string; line: number; match: string; reading: string }>; count: number };
    expect(secrets.count).toBe(1);
    // The report never repeats the flagged value.
    expect(secrets.findings).toEqual([{ file: 'config.ts', line: 2, match: "const apiSecret = '[redacted]';", reading: 'real' }]);
    expect(readings.requests).toHaveLength(1);
  });

  test('a dismissed placeholder is counted, an uncertain line listed for review', async () => {
    await writeFixture(tmpDir, 'settings.ts', `const suggestedToken = 'changeme-placeholder';\nconst opaqueValue = 'maybe-a-real-token-9';\n`);
    await writeFixture(tmpDir, 'more.ts', `const opaqueValue_apiKey = 'maybe-a-real-token-9';\n`);

    const result = await runSecurity({ mode: 'security', securityScope: 'secrets', projectRoot: tmpDir }, tmpDir);

    const secrets = result.secrets as { findings: Array<{ file: string; line: number; reading: string }>; dismissed: number };
    expect(secrets.dismissed).toBe(1);
    expect(secrets.findings).toEqual([expect.objectContaining({ file: 'more.ts', line: 1, reading: 'uncertain' })]);
  });

  test('a reading sees the candidate and two lines on each side, never the whole file', async () => {
    const filler = Array.from({ length: 200 }, (_, index) => `export const value${index} = ${index};`);
    filler.splice(100, 0, "const apiSecret = 'supersecretvalue123';");
    await writeFixture(tmpDir, 'big.ts', `${filler.join('\n')}\n`);

    await runSecurity({ mode: 'security', securityScope: 'secrets', projectRoot: tmpDir }, tmpDir);

    expect(readings.requests).toHaveLength(1);
    const state = readings.requests[0]!.state as { line: string; before: string[]; after: string[] };
    expect(state.before).toHaveLength(2);
    expect(state.after).toHaveLength(2);
  });

  test('a line holding a declared credential is reported from the local patterns without being sent', async () => {
    await writeFixture(tmpDir, 'a-clean.ts', 'export const first = 1;\nexport const second = 2;\n');
    await writeFixture(tmpDir, 'z-private.ts', 'const password = "synthetic-private-value";\n');
    const result = await runSecurity({ mode: 'security', securityScope: 'secrets', projectRoot: tmpDir }, tmpDir);
    const secrets = result.secrets as { findings: Array<{ file: string; reading: string }>; files_scanned: number };
    expect(secrets.files_scanned).toBe(2);
    expect(secrets.findings).toEqual([expect.objectContaining({ file: 'z-private.ts', reading: 'local-pattern' })]);
    expect(JSON.stringify(readings.requests)).not.toContain('synthetic-private-value');
  });

  // A process running as root can read a mode-000 file, so the refusal cannot be produced there.
  test.skipIf(process.getuid?.() === 0)('a file that cannot be read is listed as unreadable, not dropped from the count', async () => {
    await writeFixture(tmpDir, 'a-clean.ts', 'export const first = 1;\n');
    const locked = await writeFixture(tmpDir, 'locked.ts', 'export const second = 2;\n');
    chmodSync(locked, 0o000);
    try {
      const result = await runSecurity({ mode: 'security', projectRoot: tmpDir }, tmpDir);
      const secrets = result.secrets as { files_scanned: number; unreadable_files?: string[] };
      expect(secrets.unreadable_files).toEqual(['locked.ts']);
      expect(secrets.files_scanned).toBe(1);
      const permissions = result.permissions as { unreadable_files?: string[] };
      expect(permissions.unreadable_files).toEqual(['locked.ts']);
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  test('a live-key shape in a flagged line is masked in the report', async () => {
    await writeFixture(tmpDir, 'billing.ts', `export const CURRENCY = 'usd';\nexport const STRIPE_KEY = '${LIVE_KEY}';\nexport const TRIAL_DAYS = 14;\n`);
    const result = await runSecurity({ mode: 'security', securityScope: 'secrets', projectRoot: tmpDir }, tmpDir);
    expect((result.secrets as { count: number }).count).toBe(1);
    expect(JSON.stringify(result)).not.toContain(LIVE_KEY);
  });

  test('security lists every dotenv file of the root, as env_audit does', async () => {
    for (const name of ['.env', '.env.staging', '.env.test']) await writeFixture(tmpDir, name, 'A=1\n');
    const result = await runSecurity({ mode: 'security', securityScope: 'env', projectRoot: tmpDir }, tmpDir);
    expect((result.env as { files_found: string[] }).files_found).toEqual(['.env', '.env.staging', '.env.test']);
  });

  test('clean code makes no decision-model request', async () => {
    await writeFixture(tmpDir, 'clean.ts', `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`);

    const result = await runSecurity({ mode: 'security', securityScope: 'secrets', projectRoot: tmpDir }, tmpDir);

    const secrets = result.secrets as { findings: unknown[]; count: number };
    expect(secrets.count).toBe(0);
    expect(readings.requests).toHaveLength(0);
  });

  test('every entry of files is scanned, not only the first', async () => {
    await mkdir(join(tmpDir, 'a'));
    await mkdir(join(tmpDir, 'b'));
    await writeFixture(tmpDir, 'a/config.ts', "const apiSecret = 'supersecretvalue123';\n");
    await writeFixture(tmpDir, 'b/config.ts', "const apiSecret = 'supersecretvalue123';\n");
    const result = await runSecurity({ mode: 'security', securityScope: 'secrets', files: ['a', 'b'], projectRoot: tmpDir }, tmpDir);
    expect((result.secrets as { findings: Array<{ file: string }> }).findings.map((f) => f.file).sort()).toEqual(['a/config.ts', 'b/config.ts']);
  });
});

// ---------------------------------------------------------------------------
// permissions mode
// ---------------------------------------------------------------------------

describe('runPermissions: permissions mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('reports the calls Jev reads as risky with its severity, and dismisses lookalikes, reading only call-shaped lines', async () => {
    await writeFixture(
      tmpDir,
      'app.js',
      [
        "app.post('/calc', (req, res) => res.send(eval(req.body.expr)));",
        'function render(el, comment) { el.innerHTML = comment.body; }',
        'while ((m = pattern.exec(text)) !== null) {}',
        'fs.chmodSync(dir, 0o777);',
        'const total = items.length;',
        '',
      ].join('\n'),
    );

    const result = await runPermissions({ mode: 'permissions', projectRoot: tmpDir }, tmpDir);

    const findings = result.findings as Array<{ line: number; severity: string; reading: string; match: string }>;
    expect(findings.map((f) => [f.line, f.severity, f.reading])).toEqual([
      [1, 'high', 'real'],
      [2, 'medium', 'real'],
      [4, 'high', 'real'],
    ]);
    expect(findings[2]!.match).toBe('fs.chmodSync(dir, 0o777);');
    // The regex exec loop is a call shape, read and dismissed; the plain assignment is never read.
    expect(result.dismissed).toBe(1);
    expect(result.by_severity).toEqual({ high: 2, medium: 1, low: 0, unrated: 0 });
    expect(readings.requests).toHaveLength(4);
  });

  test('with decision models off every call shape is listed unassessed and nothing is sent', async () => {
    await writeFixture(tmpDir, 'app.js', "app.post('/calc', (req, res) => res.send(eval(req.body.expr)));\n");
    const result = await withDecisionModelPolicy(() => 'Classic - Off', () => runPermissions({ mode: 'permissions', projectRoot: tmpDir }, tmpDir));
    expect((result.findings as Array<{ reading: string }>).map((f) => f.reading)).toEqual(['unassessed']);
    expect(readings.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// env_audit mode
// ---------------------------------------------------------------------------

describe('runEnvAudit: env_audit mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('compares every file against the template Jev picks, sending no values', async () => {
    await writeFixture(tmpDir, '.env.example', 'DATABASE_URL=\nSTRIPE_KEY=\nSENTRY_DSN=\n');
    await writeFixture(tmpDir, '.env', 'DATABASE_URL=postgres://local\nSTRIPE_KEY=secret-value-1\nDEBUG=1\n');

    const result = await runEnvAudit({ mode: 'env_audit' }, tmpDir);

    expect(result.reference).toBe('.env.example');
    expect(result.missing).toEqual([{ key: 'SENTRY_DSN', present_in: '.env.example', missing_from: ['.env'] }]);
    expect(result.extra).toEqual([{ key: 'DEBUG', only_in: '.env' }]);
    expect(JSON.stringify(readings.requests[0]!.state)).not.toContain('secret-value-1');
  });

  test('every dotenv-named file at the root is audited, whatever its suffix', async () => {
    await writeFixture(tmpDir, '.env.template', 'API_URL=\nLOG_LEVEL=\n');
    await writeFixture(tmpDir, '.env.staging', 'API_URL=https://staging\n');
    await writeFixture(tmpDir, '.environment-notes', 'not an env file\n');

    const result = await runEnvAudit({ mode: 'env_audit' }, tmpDir);

    expect(result.files).toEqual([{ name: '.env.staging', key_count: 1 }, { name: '.env.template', key_count: 2 }]);
    const offered = (readings.requests[0]!.state as { candidates: Array<{ id: string }> }).candidates.map((candidate) => candidate.id);
    expect(offered).toEqual(['.env.staging', '.env.template']);
  });

  test('with no template read, compares nothing', async () => {
    await writeFixture(tmpDir, '.env', 'PORT=3000\n');
    await writeFixture(tmpDir, '.env.local', 'PORT=4000\nDEBUG=1\n');

    const result = await runEnvAudit({ mode: 'env_audit' }, tmpDir);

    expect(result.reference).toBeNull();
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.files).toEqual([{ name: '.env', key_count: 1 }, { name: '.env.local', key_count: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// test_find mode
// ---------------------------------------------------------------------------

describe('runTestFind: test_find mode', () => {
  let tmpDir: string;

  function expectTestFindReadings(source: string, selectionCount: number) {
    expect(readings.requests).toHaveLength(selectionCount);
    const selections = readings.requests;
    for (const request of selections) {
      const state = request.state as { context: { source: string }; candidates: Array<{ id: string }> };
      expect(state.context).toEqual({ source });
      expect(Object.keys(request.questions ?? {}).sort())
        .toEqual(['pick', ...state.candidates.map((_, index) => `fits_${index}`)].sort());
    }
    return selections;
  }

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
    await mkdir(join(tmpDir, 'src'), { recursive: true });
    await mkdir(join(tmpDir, 'test'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('offers the files importing the source (multi-line and .js-to-.ts imports) and reports the pick', async () => {
    await writeFixture(tmpDir, 'src/cart.ts', 'export function subtotal(lines: number[]): number {\n  return lines.reduce((a, b) => a + b, 0);\n}\n');
    await writeFixture(tmpDir, 'src/checkout.ts', "import { subtotal } from './cart.js';\nexport const total = subtotal([1]);\n");
    await writeFixture(tmpDir, 'test/cart-totals.test.ts', "import {\n  subtotal,\n} from '../src/cart';\ntest('adds', () => expect(subtotal([1, 2])).toBe(3));\n");
    await writeFixture(tmpDir, 'src/other.ts', "import { x } from './elsewhere';\n");

    const result = await runTestFind({ mode: 'test_find', files: ['src/cart.ts'] }, tmpDir);

    expect(result.mappings).toEqual([{ source: 'src/cart.ts', test: 'test/cart-totals.test.ts', exists: true, candidates_checked: 2 }]);
    const selections = expectTestFindReadings('src/cart.ts', 1);
    const offered = (selections[0]!.state as { candidates: Array<{ id: string }> }).candidates.map((candidate) => candidate.id).sort();
    expect(offered).toEqual(['src/checkout.ts', 'test/cart-totals.test.ts']);
  });

  test('with more importers than one selection takes, the pick of each group goes on to a final selection', async () => {
    await writeFixture(tmpDir, 'src/cart.ts', 'export const subtotal = (lines: number[]) => lines.length;\n');
    for (let index = 0; index < TEST_CANDIDATES_PER_READING + 4; index++) {
      await writeFixture(tmpDir, `src/user-${index}.ts`, "import { subtotal } from './cart';\n");
    }
    await writeFixture(tmpDir, 'test/cart-totals.test.ts', "import { subtotal } from '../src/cart';\n");

    const result = await runTestFind({ mode: 'test_find', files: ['src/cart.ts'] }, tmpDir);

    expect(result.mappings).toEqual([{ source: 'src/cart.ts', test: 'test/cart-totals.test.ts', exists: true, candidates_checked: TEST_CANDIDATES_PER_READING + 5 }]);
    // One directory reading, two groups, then a final selection over the single pick.
    const selections = expectTestFindReadings('src/cart.ts', 3);
    expect((selections[2]!.state as { candidates: unknown[] }).candidates).toHaveLength(1);
  });

  test('a source nothing imports asks no test selection', async () => {
    await writeFixture(tmpDir, 'src/lonely.ts', 'export const x = 1;\n');

    const result = await runTestFind({ mode: 'test_find', files: ['src/lonely.ts'] }, tmpDir);

    expect(result.mappings).toEqual([{ source: 'src/lonely.ts', test: null, exists: false, candidates_checked: 0 }]);
    expectTestFindReadings('src/lonely.ts', 0);
  });

  test('importers Jev reads as no test report none', async () => {
    await writeFixture(tmpDir, 'src/hash.ts', 'export const hash = (s: string) => s.length;\n');
    await writeFixture(tmpDir, 'src/index.ts', "export * from './hash';\n");

    const result = await runTestFind({ mode: 'test_find', files: ['src/hash.ts'] }, tmpDir);

    expect(result.mappings).toEqual([{ source: 'src/hash.ts', test: null, exists: false, candidates_checked: 1 }]);
    expectTestFindReadings('src/hash.ts', 1);
  });
});

// ---------------------------------------------------------------------------
// dead_code mode
// ---------------------------------------------------------------------------

describe('runDeadCode: dead_code mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeFixtureDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('flags an exported function that is never referenced elsewhere', async () => {
    // Fixture A: exports a function nobody uses
    await writeFixture(
      tmpDir,
      'lib.ts',
      `/* fixture: scan-target */\nexport function orphanedHelper(): void {\n  void 0;\n}\n`,
    );
    // Fixture B: unrelated file that doesn't reference orphanedHelper
    await writeFixture(
      tmpDir,
      'main.ts',
      `/* fixture: scan-target */\nexport function main(): void {\n  void 0;\n}\n`,
    );

    const result = await runDeadCode(
      { mode: 'dead_code', projectRoot: tmpDir },
      tmpDir,
    );

    const deadExports = result.dead_exports as Array<{ name: string; file: string; line: number }>;
    expect(deadExports).toBeInstanceOf(Array);
    const deadNames = deadExports.map((e) => e.name);
    expect(deadNames).toContain('orphanedHelper');
    expect(result.total_exports).toBe(2);
  });

  test('does NOT flag an exported function that is referenced in another file', async () => {
    // Fixture A: exports a function
    await writeFixture(
      tmpDir,
      'utils.ts',
      `export function computeSum(a: number, b: number): number {\n  return a + b;\n}\n`,
    );
    // Fixture B: imports and uses computeSum
    await writeFixture(
      tmpDir,
      'consumer.ts',
      `/* fixture: scan-target */\nimport { computeSum } from './utils.js';\nexport function run(): void {\n  const result = computeSum(1, 2);\n  console.log(result);\n}\n`,
    );

    const result = await runDeadCode(
      { mode: 'dead_code', projectRoot: tmpDir },
      tmpDir,
    );

    const deadExports = result.dead_exports as Array<{ name: string; file: string; line: number }>;
    expect(deadExports).toBeInstanceOf(Array);
    const deadNames = deadExports.map((e) => e.name);
    // computeSum is referenced in consumer.ts, must NOT appear as dead
    expect(deadNames).not.toContain('computeSum');
  });
});


test.each([0.7, 0.3])('tentative scan verdicts remain visible as uncertain (%s)', async probability => {
  const dir = await makeFixtureDir();
  const fixture = fakePort((_name, question) => question.type === 'noul' ? noulAnswer(probability) : choiceAnswer(question, 'high', 0.99));
  installJudgmentPort(fixture.port);
  try {
    await writeFixture(dir, 'app.js', 'fs.chmodSync(dir, 0o777);');
    const result = await runPermissions({ mode: 'permissions', projectRoot: dir }, dir);
    expect(result.findings).toEqual([expect.objectContaining({ reading: 'uncertain' })]);
    expect(result.dismissed).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

/** Real product processes + paired daemon; only external model responses are fixtures.
 * The same tests can run against source or the existing compiled-binary overrides.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEADLESS_PROMPT, HEADLESS_REPLY, makeHeadlessFixture, readEnvelope, type HeadlessFixtureOptions, type HeadlessProduct } from './native-headless-process-harness.ts';
import { lastUserText } from '../e2e/harness.ts';

const json = ['--output-format', 'json'];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); }, 30000);
async function fixture(product: HeadlessProduct, options: HeadlessFixtureOptions) {
  const f = await makeHeadlessFixture(product, HEADLESS_REPLY, options); cleanups.push(() => f.close()); return f;
}

for (const product of ['agent', 'tui'] as const) describe(`${product} decision policy through real startup/work/completion`, () => {
  test('Classic without credentials edits, reads, executes once, completes and resumes its saved conversation', async () => {
    let workspace = '';
    // The process fixture deliberately has a minimal PATH. Use the actual
    // test runner runtime, including when the product itself is a native binary.
    const bun = `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const f = await fixture(product, { policy: 'Classic - Off', missingCredentials: true,
      settings: { 'permissions.mode': 'yolo', 'sandbox.enabled': false },
      answer(request) {
        if (lastUserText(request) !== HEADLESS_PROMPT) return { text: HEADLESS_REPLY };
        const results = request.messages.filter(message => message.role === 'tool').length;
        if (results === 0) return { toolCalls: [{ name: 'write', arguments: { files: [
          { path: 'classic-work.txt', content: 'Native edit landed\n', mode: 'fail_if_exists' },
          { path: 'classic-proof.test.ts', mode: 'fail_if_exists', content: [
            "import { expect, test } from 'bun:test';",
            "import { appendFileSync, readFileSync } from 'node:fs';",
            "test('native edit and command results remain usable', () => {",
            "  expect(readFileSync('classic-work.txt', 'utf8')).toBe('Native edit landed\\n');",
            "  expect(readFileSync('classic-execution.log', 'utf8')).toBe('native-execution\\n');",
            "  appendFileSync('classic-tests.log', 'passed\\n');",
            '});',
          ].join('\n') },
        ] } }] };
        if (results === 1) return { toolCalls: [{ name: 'read', arguments: { files: [{ path: 'classic-work.txt' }] } }] };
        if (results === 2) return { toolCalls: [{ name: 'exec', arguments: { working_dir: workspace,
          commands: [{ cmd: "printf 'native-execution\\n' >> classic-execution.log" }] } }] };
        if (results === 3) return { toolCalls: [{ name: 'exec', arguments: { working_dir: workspace,
          commands: [{ cmd: `${bun} test ./classic-proof.test.ts` }] } }] };
        return { text: HEADLESS_REPLY };
      },
    });
    workspace = f.home.workspace;
    const first = await f.run(['run', HEADLESS_PROMPT, ...json]);
    expect(first.code, JSON.stringify({ output: first, intake: f.door.responses })).toBe(0);
    expect(readEnvelope(first).response).toBe(HEADLESS_REPLY);
    expect(readFileSync(join(workspace, 'classic-work.txt'), 'utf8')).toBe('Native edit landed\n');
    expect(readFileSync(join(workspace, 'classic-execution.log'), 'utf8')).toBe('native-execution\n');
    expect(readFileSync(join(workspace, 'classic-tests.log'), 'utf8')).toBe('passed\n');
    expect(f.home.judgments.allRequests).toHaveLength(0);

    // A new actual process loads the saved history. Existing tool results must
    // reach its answering model; they must not be executed again after resume.
    const resumed = await f.run(['run', HEADLESS_PROMPT, '--continue', ...json]);
    expect(resumed.code, JSON.stringify({ output: resumed, intake: f.door.responses })).toBe(0);
    expect(readEnvelope(resumed).response).toBe(HEADLESS_REPLY);
    const latest = f.model.requests.filter(request => lastUserText(request) === HEADLESS_PROMPT).at(-1);
    expect(JSON.stringify(latest?.messages)).toContain('Native edit landed');
    expect(latest?.messages.filter(message => message.role === 'tool').length).toBeGreaterThanOrEqual(4);
    expect(readFileSync(join(workspace, 'classic-execution.log'), 'utf8')).toBe('native-execution\n');
    expect(readFileSync(join(workspace, 'classic-tests.log'), 'utf8')).toBe('passed\n');
    expect(f.home.judgments.allRequests).toHaveLength(0);
    expect(`${first.stdout}${resumed.stdout}`).not.toContain(f.pairedToken);
  }, 60000);

  test('Classic missing resume never submits a fresh turn or replaces the last saved conversation', async () => {
    const f = await fixture(product, { policy: 'Classic - Off', missingCredentials: true });
    const first = await f.run(['run', HEADLESS_PROMPT, ...json]);
    expect(first.code, first.stdout).toBe(0);
    const calls = f.model.requests.filter(request => lastUserText(request) === HEADLESS_PROMPT).length;
    const missing = await f.run(['run', HEADLESS_PROMPT, '--resume', 'does-not-exist', ...json]);
    expect(missing.code).not.toBe(0);
    expect(readEnvelope(missing).ok).toBe(false);
    expect(f.model.requests.filter(request => lastUserText(request) === HEADLESS_PROMPT)).toHaveLength(calls);
    const resumed = await f.run(['run', HEADLESS_PROMPT, '--continue', ...json]);
    expect(resumed.code, resumed.stdout).toBe(0);
    const latest = f.model.requests.filter(request => lastUserText(request) === HEADLESS_PROMPT).at(-1);
    expect(latest?.messages.filter(message => message.role === 'user')).toHaveLength(2);
    expect(f.home.judgments.allRequests).toHaveLength(0);
  }, 60000);

  test('Preferred exhausted endpoint continues ordinary chat and completion', async () => {
    const f = await fixture(product, { policy: 'Preferred', unavailable: true });
    const output = await f.run(['run', HEADLESS_PROMPT, ...json]);
    expect(output.code, JSON.stringify({ output, intake: f.door.responses })).toBe(0);
    expect(readEnvelope(output).response).toBe(HEADLESS_REPLY);
    expect(f.home.judgments.allRequests.length).toBeGreaterThan(0);
    expect(f.model.requests.filter(request => lastUserText(request) === HEADLESS_PROMPT)).toHaveLength(1);
  }, 60000);

  test('Default - On exhausted endpoint cannot publish success or execute a decision-dependent write', async () => {
    const f = await fixture(product, { policy: 'Default - On', unavailable: true,
      settings: { 'permissions.mode': 'safe-jev' },
      answer(request) {
        if (lastUserText(request) === HEADLESS_PROMPT && !request.messages.some(message => message.role === 'tool')) {
          return { toolCalls: [{ name: 'write', arguments: { files: [{ path: 'classic-work.txt', content: 'Must not be written' }] } }] };
        }
        return { text: HEADLESS_REPLY };
      },
    });
    const output = await f.run(['run', HEADLESS_PROMPT, ...json]);
    expect(output.code).not.toBe(0);
    expect(f.home.judgments.allRequests.length).toBeGreaterThan(0);
    expect(readEnvelope(output).ok).toBe(false);
    expect(existsSync(join(f.home.workspace, 'classic-work.txt'))).toBe(false);
    expect(`${output.stdout}${output.stderr}`).not.toContain(f.pairedToken);
  }, 60000);

  test('Preferred outage after the answering request preserves the captured answer without replay', async () => {
    const f = await fixture(product, { policy: 'Preferred' });
    const held = f.holdAdmittedModelRequest(), child = f.start(['run', HEADLESS_PROMPT, ...json]);
    try {
      await Promise.race([held.entered, child.output.then(output => { throw new Error(`Exited before model: ${output.stdout} ${output.stderr}`); })]);
      const before = f.home.judgments.allRequests.length;
      f.home.judgments.setUnavailable(true); held.release();
      const output = await child.output;
      expect(output.code, output.stderr).toBe(0);
      expect(readEnvelope(output).response).toBe(HEADLESS_REPLY);
      expect(f.home.judgments.allRequests.length).toBeGreaterThan(before);
      expect(f.model.requests.filter(request => lastUserText(request) === HEADLESS_PROMPT)).toHaveLength(1);
    } finally { held.release(); }
  }, 60000);

  test('Classic cancellation flushes an honest result and shutdown makes no decision requests', async () => {
    const f = await fixture(product, { policy: 'Classic - Off', missingCredentials: true });
    const held = f.holdAdmittedModelRequest(), child = f.start(['run', HEADLESS_PROMPT, ...json]);
    try {
      await Promise.race([held.entered, child.output.then(output => { throw new Error(`Exited before model: ${output.stdout} ${output.stderr}`); })]);
      child.interrupt('SIGINT');
      const output = await child.output;
      expect(output.code, output.stderr).toBe(130);
      expect(readEnvelope(output).ok).toBe(false);
      expect(f.home.judgments.allRequests).toHaveLength(0);
      expect(f.model.requests.filter(request => lastUserText(request) === HEADLESS_PROMPT)).toHaveLength(1);
      expect(output.stdout).not.toContain(f.pairedToken);
    } finally { held.release(); }
  }, 60000);
});

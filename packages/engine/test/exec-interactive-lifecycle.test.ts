/**
 * Interactive exec run lifecycle: dropped answers are reported, cancel and
 * timeout are exclusive, and a stop reaches processes the wrapper started.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPtyAvailability, probePtyHost, runInteractiveCommand, type ExecInteractionRuntime } from '../platform/src/platform/tools/exec/interactive.ts';
import { formatResult } from '../platform/src/platform/tools/exec/result-format.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';
import { requireLiveHost } from './_helpers/exec-containment-proof.ts';

useToolReadings([
  ['"lastLine":"First? [y/n]:"', { awaitingInput: true }],
  ['"lastLine":"Second? [y/n]:"', { awaitingInput: true }],
]);

const LIVE_PTY = detectPtyAvailability(probePtyHost());
requireLiveHost('PTY', LIVE_PTY.available);
const interaction = (over: Partial<ExecInteractionRuntime> = {}): ExecInteractionRuntime => ({ availability: LIVE_PTY, quietWindowMs: 250, ...over });
const env = process.env as Record<string, string>;
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  // A killed child stays a zombie until init reaps it.
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(')')[1]!.trim()[0] !== 'Z'; } catch { return false; }
};

describe.skipIf(!LIVE_PTY.available)('runInteractiveCommand lifecycle (live PTY)', () => {
  test('an answer overtaken by new output is reported as dropped and the prompt is asked again', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'exec-drop-')));
    const gate = join(dir, 'gate');
    try {
      const script =
        `printf "First? [y/n]: " > /dev/tty; while [ ! -e ${gate} ]; do sleep 0.05; done; ` +
        'printf "\\nstill working\\nSecond? [y/n]: " > /dev/tty; read ans < /dev/tty; echo "got:$ans"';
      const asked: string[] = [];
      const result = await runInteractiveCommand({
        cmdStr: script, cwd: undefined, env, timeoutMs: 20_000, startTime: Date.now(), sandboxArgv: [],
        interaction: interaction({
          requestPromptAnswer: async (ask, execution) => {
            asked.push(ask.prompt);
            if (asked.length === 1) {
              // The user is still typing when the child prints more.
              await Bun.write(gate, '1');
              for (;;) { try { execution!.assertCurrent(); } catch { break; } await Bun.sleep(10); }
            }
            return { answered: true, text: 'y' };
          },
        }),
      });
      expect(asked).toEqual(['First? [y/n]:', 'Second? [y/n]:']);
      expect(result.prompts_dropped).toBe(1);
      expect(result.prompts_answered).toBe(1);
      expect(result.stdout).toContain('got:y');
      for (const verbosity of ['count_only', 'minimal', 'standard', 'verbose'] as const) {
        const shaped = formatResult(result, verbosity);
        expect(shaped.prompts_dropped).toBe(1);
        expect(String(shaped.prompt_dropped_note)).toContain('not sent');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);

  test('a cancel that lands before the timeout fires is reported as cancelled only', async () => {
    const controller = new AbortController();
    const result = await runInteractiveCommand({
      cmdStr: 'sleep 30', cwd: undefined, env, timeoutMs: 1, startTime: Date.now(), sandboxArgv: [],
      interaction: interaction(), signal: controller.signal,
      beforeSpawn: () => controller.abort(),
    });
    expect(result.cancelled).toBe(true);
    expect(result.timed_out).toBeUndefined();
  }, 20_000);

  test('a timeout stops processes the command detached from its own shell', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'exec-tree-')));
    const pidFile = join(dir, 'pid');
    try {
      const result = await runInteractiveCommand({
        cmdStr: `nohup sleep 300 >/dev/null 2>&1 & echo $! > ${pidFile}; sleep 300`,
        cwd: undefined, env, timeoutMs: 1500, startTime: Date.now(), sandboxArgv: [], interaction: interaction(),
      });
      expect(result.timed_out).toBe(true);
      expect(existsSync(pidFile)).toBe(true);
      expect(alive(Number(readFileSync(pidFile, 'utf8').trim()))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 20_000);
});

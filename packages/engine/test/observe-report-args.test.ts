import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const ENGINE_ROOT = resolve(import.meta.dir, '..');

function report(...args: string[]): { status: number | null; stderr: string } {
  const result = Bun.spawnSync(['bun', 'scripts/observe-report.ts', ...args], { cwd: ENGINE_ROOT });
  return { status: result.exitCode, stderr: result.stderr.toString() };
}

describe('observe-report arguments', () => {
  test.each([
    [['--windows', 'x'], '--windows'],
    [['--windows', '0'], '--windows'],
    [['--since', 'yesterday-ish'], '--since'],
    [['--until', 'later'], '--until'],
  ])('%j is a usage error naming the flag', (args, flag) => {
    const result = report(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(flag);
  });
});

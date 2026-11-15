import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ShellContextHold, ShellPassthrough, SHELL_OUTPUT_LIMIT_CHARS, withShellContext } from '../../input/shell-passthrough.ts';

const cwd = process.cwd();

describe('ShellPassthrough', () => {
  test('buffers the output as context for the next message and gives it back when that message is not sent', async () => {
    const shell = new ShellPassthrough();
    const result = await shell.run('echo hello', cwd);
    expect(result.display).toContain('hello');
    expect(result.display).toContain('exit 0');
    const taken = shell.takeContext();
    expect(taken).toHaveLength(1);
    expect(shell.takeContext()).toEqual([]);
    shell.restoreContext(taken);
    expect(shell.consumeContext('question')).toContain('hello');
    expect(shell.consumeContext('question')).toBe('question');
  });

  test('restored context goes back ahead of what was buffered since', async () => {
    const shell = new ShellPassthrough();
    await shell.run('echo first', cwd);
    const taken = shell.takeContext();
    await shell.run('echo second', cwd);
    shell.restoreContext(taken);
    const text = shell.consumeContext('go');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
  });

  test('a command that is still running is stopped by cancelRunning and the result says so', async () => {
    const shell = new ShellPassthrough();
    const running = shell.run('sleep 30', cwd);
    shell.cancelRunning();
    const result = await running;
    expect(result.display).toContain('stopped before it finished');
  });

  test('stopping a pipeline stops every part of it, not only the shell', async () => {
    const shell = new ShellPassthrough();
    const pidFile = join(tmpdir(), `gv-shell-pipeline-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const running = shell.run(`bash -c 'echo $$ > ${pidFile}; exec sleep 300' | cat`, cwd);
    try {
      while (!existsSync(pidFile) || readFileSync(pidFile, 'utf8').trim() === '') await Bun.sleep(5);
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      shell.cancelRunning();
      await running;
      const alive = (): boolean => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      };
      while (alive()) await Bun.sleep(5);
      expect(alive()).toBe(false);
    } finally {
      rmSync(pidFile, { force: true });
    }
  });

  test('a command that outlives its timeout is stopped and the result says so', async () => {
    const shell = new ShellPassthrough();
    const result = await shell.run('sleep 30', cwd, { timeoutMs: 1 });
    expect(result.display).toContain('without finishing');
  });

  test('output past the limit is cut, counted, and not sent to the model whole', async () => {
    const shell = new ShellPassthrough();
    const total = SHELL_OUTPUT_LIMIT_CHARS * 3;
    const result = await shell.run(`head -c ${total} /dev/zero | tr '\\0' 'x'`, cwd);
    expect(result.display.length).toBeLessThan(SHELL_OUTPUT_LIMIT_CHARS + 500);
    expect(result.display).toMatch(/output cut: \d+ more characters not kept/);
    expect(result.context.length).toBeLessThan(SHELL_OUTPUT_LIMIT_CHARS + 500);
  });

  test('only the latest blocks are kept when many commands run before a message', async () => {
    const shell = new ShellPassthrough();
    for (let i = 0; i < 12; i++) await shell.run(`echo run-${i}`, cwd);
    const blocks = shell.takeContext();
    expect(blocks.length).toBeLessThan(12);
    expect(blocks.at(-1)).toContain('run-11');
    expect(blocks.join('\n')).not.toContain('run-0\n');
  });

  test('withShellContext puts blocks in front of the message', () => {
    expect(withShellContext([], 'hi')).toBe('hi');
    expect(withShellContext(['a', 'b'], 'hi')).toBe('a\n\nb\n\nhi');
    expect(withShellContext(['a'], '')).toBe('a');
  });
});

describe('ShellContextHold', () => {
  test('a refused message gets its shell context back, an admitted one does not', async () => {
    const shell = new ShellPassthrough();
    const hold = new ShellContextHold(shell);
    await shell.run('echo kept', cwd);
    const first = hold.take();
    expect(first.blocks).toHaveLength(1);
    expect(shell.takeContext()).toEqual([]);
    first.restore();
    expect(shell.consumeContext('retry')).toContain('kept');

    await shell.run('echo gone', cwd);
    const second = hold.take();
    second.release();
    second.restore();
    expect(shell.consumeContext('later')).toBe('later');
  });

  test('restoring twice does not duplicate the context', async () => {
    const shell = new ShellPassthrough();
    const hold = new ShellContextHold(shell);
    await shell.run('echo once', cwd);
    const handle = hold.take();
    handle.restore();
    handle.restore();
    expect(shell.takeContext()).toHaveLength(1);
  });

  test('a second message sent while the first is still being routed cannot erase what the first would restore', async () => {
    const shell = new ShellPassthrough();
    const hold = new ShellContextHold(shell);
    await shell.run('echo from-first', cwd);
    const first = hold.take();
    const second = hold.take();
    expect(second.blocks).toEqual([]);
    second.release();
    first.restore();
    expect(shell.consumeContext('retry')).toContain('from-first');
  });
});

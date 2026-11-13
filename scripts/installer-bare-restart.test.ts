/** Bare-process relaunch must never replay arguments it cannot reproduce exactly. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'installer-bare-restart-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function restart(extraArgs: string[]) {
  // A real, harmless child (a shell sleeping); extraArgs become its trailing argv.
  const holder = join(root, 'holder.sh'); writeFileSync(holder, 'sleep 30\n:\n');
  // Detached from this test process, so an exited process is reaped by init instead of lingering as our zombie.
  const pid = Number(execFileSync('sh', ['-c', 'setsid sh "$@" >/dev/null 2>&1 </dev/null & echo $!', 'x', holder, ...extraArgs], { encoding: 'utf8' }).trim());
  const newBin = join(root, 'goodvibes-agent');
  writeFileSync(newBin, '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done > "$FIXTURE_OUT"\n'); chmodSync(newBin, 0o755);
  try {
    const result = spawnSync('sh', ['-c', `set -eu
      . "$1"
      pids_owned_by_install() { printf '%s' "$FIXTURE_PID"; }
      report_foreign_processes() { :; }
      pid_supervision() { echo unsupervised; }
      proc_belongs_to_install_dir() { return 0; }
      restart_bare_processes goodvibes-agent "$FIXTURE_BIN"
    `, 'x', resolve(import.meta.dir, 'install.sh')], { encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, HOME: root, GOODVIBES_INSTALL_SH_LIB: '1', FIXTURE_PID: String(pid), FIXTURE_BIN: newBin, FIXTURE_OUT: join(root, 'out') } });
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    return { result, alive };
  } finally { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
}

test('an argument with a space is not replayed: the process is left running and the quoted command is printed', () => {
  const { result, alive } = restart(['--name', 'two words']);
  expect(result.status, result.stderr).toBe(0);
  expect(alive).toBe(true);
  expect(result.stdout).toContain('Skipping pid');
  expect(result.stdout).toContain("'--name' 'two words'");
  expect(existsSync(join(root, 'out'))).toBe(false);
});

test('a glob character is not replayed either', () => {
  const { result, alive } = restart(['*.json']);
  expect(alive).toBe(true);
  expect(result.stdout).toContain("'*.json'");
});

test('plain arguments are still replayed exactly as before', () => {
  const { result, alive } = restart(['--port', '3499']);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).not.toContain('Skipping pid');
  expect(readFileSync(join(root, 'out'), 'utf8')).toBe(`[${join(root, 'holder.sh')}]\n[--port]\n[3499]\n`);
});

test('an argument with an embedded newline is not replayed', () => {
  const { result, alive } = restart(['--name', 'line1\nline2']);
  expect(result.status, result.stderr).toBe(0);
  expect(alive).toBe(true);
  expect(result.stdout).toContain('Skipping pid');
  expect(existsSync(join(root, 'out'))).toBe(false);
});

test('the printed command keeps a trailing empty argument', () => {
  const { result, alive } = restart(['--name', '']);
  expect(alive).toBe(true);
  expect(result.stdout).toContain("'--name' '' >/dev/null 2>&1 &");
});

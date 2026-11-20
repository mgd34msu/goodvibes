// Proves: Words that arrived by voice never run as a shell command.
// Red when: A transcript starting with ! runs through the shell passthrough on any of the three spoken routes; the typed control shows the marker command does run.
/**
 * Words that arrived by voice never run as a shell command. A transcript that
 * starts with `!` goes to the model as said, whether it came from the
 * microphone (the port voice capture is given) or from the command context's
 * spoken-input port; the same text typed into the composer does run.
 *
 * The app's real submission routing (shell/owner-submission.ts, as main()
 * builds it), a real ShellPassthrough running bash and the real session memory
 * store. The turn is the stand-in: it records what would have gone to the
 * model. "Did not run" is a
 * marker file the command would have created, read after every command
 * started here has finished.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionMemoryStore } from '@goodvibes-jev/engine/platform/platform/core';
import { ShellPassthrough } from '@goodvibes-jev/engine/terminal-shell/shell-passthrough';
import { createShellSubmissionPorts } from '@goodvibes-jev/engine/terminal-shell/shell-frame-facts';
import { createOwnerSubmission } from '../../shell/owner-submission.ts';

const dir = mkdtempSync(join(tmpdir(), 'spoken-no-shell-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function shell() {
  const passthrough = new ShellPassthrough();
  const turns: string[] = [];
  const submission = createOwnerSubmission({
    shellPassthrough: passthrough,
    workingDir: dir,
    sessionMemoryStore: new SessionMemoryStore(),
    begin: () => {},
    switchModels: () => {},
    answerOptions: () => ({}),
    sendTurn: (text) => { turns.push(text); },
    notify: () => {},
    showShellOutput: () => {},
    render: () => {},
  });
  // The command context's ports, built from the same two functions main() passes.
  const ports = createShellSubmissionPorts(submission.submitInput, submission.submitTurn, () => false, () => ({ pasted: false }));
  return { passthrough, turns, submission, ports };
}

const touching = (name: string) => `!touch '${join(dir, name)}'`;

test('a spoken `!` is sent to the model as said and runs nothing; the same text typed runs', async () => {
  const app = shell();

  app.submission.submitSpeech(touching('microphone'));
  app.ports.submitSpokenInput(touching('spoken-port'));
  app.submission.submitInput(touching('spoken-flag'), undefined, { spokenOutput: true });
  await app.submission.shellCommandsSettled();

  expect(existsSync(join(dir, 'microphone'))).toBe(false);
  expect(existsSync(join(dir, 'spoken-port'))).toBe(false);
  expect(existsSync(join(dir, 'spoken-flag'))).toBe(false);
  expect(app.passthrough.takeContext()).toEqual([]);
  expect(app.turns).toEqual([touching('microphone'), touching('spoken-port'), touching('spoken-flag')]);

  // The control: typed, the same marker runs the command and sends no turn.
  app.ports.submitInput(touching('typed'));
  await app.submission.shellCommandsSettled();
  expect(existsSync(join(dir, 'typed'))).toBe(true);
  expect(app.turns).toHaveLength(3);
});

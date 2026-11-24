/**
 * cli-hidden-input.ts, reading a secret typed at the terminal.
 *
 * What is typed is never echoed, so it stays off the screen and out of the
 * scrollback, and it never reaches the command line, so it stays out of the
 * shell history and the process list.
 */
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

/**
 * Ask for a secret on the terminal without echoing it. The question goes to
 * stderr when `toStderr` is set (so stdout carries only the command's answer),
 * else to stdout. Only ever called when stdin is a terminal.
 *
 * Ctrl+C ends the program as it would anywhere else (the terminal is in raw
 * mode while asking, so the key arrives as input and is raised here); Ctrl+D
 * on an empty line answers with nothing. Either way the answer is empty.
 */
export async function askSecretOnStdin(question: string, toStderr = false): Promise<string> {
  const out = toStderr ? process.stderr : process.stdout;
  out.write(question);
  const swallow = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input: process.stdin, output: swallow, terminal: true });
  let interrupted = false;
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once('SIGINT', () => { interrupted = true; resolve(''); });
      rl.once('close', () => resolve(''));
      rl.question('').then(resolve, () => resolve(''));
    });
    return answer.trim();
  } finally {
    rl.close();
    out.write('\n');
    if (interrupted) process.kill(process.pid, 'SIGINT');
  }
}

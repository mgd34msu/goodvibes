// The other process of the program-socket proof (capability-run-gate.test.ts): a process of this account run by the
// same runtime as the test (the daemon there runs from source), holding the terminal app's source entry open as a
// program from source does while it is read, private except for the daemon's step.
//   live:  registers through the product's own client and prints `KEY <key>`; ends when its standard input closes.
//   cross: opens two connections and answers the first one's challenge on the second; prints `cross <what came back>`.
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { keepProcessPrivate, openForReading } from '../../platform/src/platform/utils/process-privacy.ts';
import { programRegistrationFor, setProgramCallContext } from '../../platform/src/platform/runtime/client/call-context.ts';
import { shortSocketPath } from '../../platform/src/platform/utils/short-socket-path.ts';

const mode = process.argv[2];
openSync(process.env['PEER_ENTRY']!, 'r');
keepProcessPrivate();
const token = process.env['PEER_TOKEN']!;

if (mode === 'live') {
  setProgramCallContext({ program: 'tui', project: () => undefined, sessionId: () => undefined });
  const key = await programRegistrationFor(`http://127.0.0.1:${process.env['PEER_PORT']}`, token);
  process.stdout.write(`KEY ${key ?? 'none'}\n`);
  for await (const _chunk of process.stdin) { /* held open until the test closes it */ }
  process.exit(0);
}

const path = join(process.env['GOODVIBES_DAEMON_HOME']!, 'programs.sock');
interface Lines { readonly seen: string[]; readonly waiting: { readonly wanted: (line: string) => boolean; readonly resolve: (line: string) => void }[] }
const firstLine = (lines: Lines, wanted: (line: string) => boolean): Promise<string> => new Promise((resolve) => {
  const found = lines.seen.find(wanted);
  if (found) resolve(found); else lines.waiting.push({ wanted, resolve });
});
const arrive = (lines: Lines, line: string): void => {
  lines.seen.push(line);
  for (const waiter of lines.waiting.splice(0)) { if (waiter.wanted(line)) waiter.resolve(line); else lines.waiting.push(waiter); }
};
const open = async (lines: Lines) => {
  const address = shortSocketPath(path);
  try {
    return await Bun.connect({ unix: address.path, socket: {
      data(_socket, data) { for (const line of Buffer.from(data).toString('utf8').split('\n').filter(Boolean)) arrive(lines, line); },
      close() { arrive(lines, 'closed'); },
    } });
  } finally {
    address.release();
  }
};
const linesA: Lines = { seen: [], waiting: [] };
const linesB: Lines = { seen: [], waiting: [] };
await open(linesA);
const b = await open(linesB);
const challengeA = String((JSON.parse(await firstLine(linesA, (line) => line.includes('challenge'))) as { challenge?: unknown }).challenge);
await firstLine(linesB, (line) => line.includes('challenge'));
const close = openForReading(150);
b.write(`${JSON.stringify({ answer: challengeA, program: 'tui', token })}\n`);
let answer = await firstLine(linesB, (line) => line.includes('refused') || line.includes('"read"') || line === 'closed');
close();
if (answer.includes('"read"')) {
  // Taken as an answer: the exchange goes on as a program's would, to its end.
  b.write('{"closed":true}\n');
  answer = await firstLine(linesB, (line) => line.includes('refused') || line.includes('"key"') || line === 'closed');
}
process.stdout.write(`cross ${/"key"/.test(answer) ? 'key' : /refused/.test(answer) ? 'refused' : answer}\n`);
process.exit(0);

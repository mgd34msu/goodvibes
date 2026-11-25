/**
 * capability-cli-confirm.ts, the one question `do` asks at a terminal (capability-cli.ts), as a place asks it: for a
 * capability that weakens a protection, cannot be undone, spends money, writes a secret or is the owner's own act, the
 * person types y at the terminal device itself, never on standard input, and Enter alone (or nothing) is No. Every
 * other capability runs at once. There is no flag that skips it: a script, a hook, an `.envrc` or a package script a
 * model left behind, run by the person's shell, cannot do such an act unseen.
 */
import { closeSync, openSync, readSync, writeSync } from 'node:fs';

/**
 * The question to put for this call, or undefined when it runs at once. Read from this program's own capability
 * definitions (the daemon's are the same build); a capability this program does not know is asked about, since what
 * it does cannot be said here.
 */
export async function doQuestion(id: string, inputs: Readonly<Record<string, string>>): Promise<string | undefined> {
  const capabilities = await import('@goodvibes/engine/platform/platform/capabilities');
  const entry = capabilities.movedCapabilityEntries().find((candidate) => candidate.id === id);
  if (!entry) return `Run ${id}? This program does not know that capability, so what it does cannot be said here.`;
  const values = capabilities.withDefaults(entry, inputs);
  let risk = capabilities.effectiveRisk(entry, values);
  const definition = capabilities.daemonCapability(id) ?? capabilities.methodCapability(id);
  if (risk === 'none' && definition?.loosensIf?.(values) === true) risk = 'loosens-a-protection';
  const why: string[] = [];
  if (risk === 'loosens-a-protection') why.push('it loosens a protection');
  if (risk === 'cannot-be-undone') why.push('it cannot be undone');
  if (risk === 'spends-money') why.push('it spends money');
  if (entry.touches === 'credential' || capabilities.capabilityEffects(entry, values).includes('secret.write')) why.push('it writes a secret');
  if (entry.ownerOnly) why.push('it is an act only you make');
  if (why.length === 0) return undefined;
  return `${entry.label}? ${why.join(', ').replace(/^./, (first) => first.toUpperCase())}.`;
}

/**
 * Put `question` at the terminal device and read one line from it: true only for y or yes. No terminal device, an
 * empty line, end of input or anything else is No. Standard input is never read.
 */
export function askAtTerminal(question: string): boolean {
  const windows = process.platform === 'win32';
  let input: number | undefined;
  let output: number | undefined;
  try {
    input = openSync(windows ? 'CONIN$' : '/dev/tty', windows ? 'r' : 'r+');
    output = windows ? openSync('CONOUT$', 'w') : input;
    writeSync(output, `${question} [y/N] `);
    const buffer = Buffer.alloc(256);
    let line = '';
    while (!line.includes('\n') && line.length < 1024) {
      const read = readSync(input, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      line += buffer.toString('utf8', 0, read);
    }
    if (!line.includes('\n')) writeSync(output, '\n');
    return /^\s*y(es)?\s*$/i.test(line.split(/\r?\n/)[0] ?? '');
  } catch {
    return false;
  } finally {
    if (output !== undefined && output !== input) { try { closeSync(output); } catch { /* closed */ } }
    if (input !== undefined) { try { closeSync(input); } catch { /* closed */ } }
  }
}

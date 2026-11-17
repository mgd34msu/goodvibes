/**
 * A second terminal for terminal-routines.test.ts: takes the routine lock at the
 * path in argv[2] through the real LocalRoutineRunner, prints whether it holds
 * it, and keeps it until it is killed or its stdin closes.
 */
import { LocalRoutineRunner } from '../../runtime/terminal-routines.ts';

const lockPath = process.argv[2];
if (!lockPath) throw new Error('usage: terminal-routines-holder.ts <lock path>');
let starts = 0;
const runner = new LocalRoutineRunner({ start: async () => { starts += 1; }, stop: () => undefined }, lockPath);
const held = await runner.ensure();
process.stdout.write(`held ${held} starts ${starts}\n`);
for await (const _chunk of Bun.stdin.stream()) { /* held until stdin closes */ }
runner.release();

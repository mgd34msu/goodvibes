/**
 * private-from-start.ts, imported FIRST by each product's entry (the terminal app, the Agent, the daemon): the process
 * turns private (not dumpable, utils/process-privacy.ts) while this module is evaluated, before any other module of
 * the program is even loaded (gate-review-6 G6).
 *
 * Why first: a handle on `/proc/<pid>/mem` is judged by the kernel when it is opened, so a process of the account that
 * opens one while the program is still readable (between its `execve` and this call) keeps reading and writing its
 * memory after the program turned private. Calling it from the entry's body, after its static imports, left the whole
 * module load (hundreds of milliseconds) open; from here, only the runtime's own start before the first module.
 *
 * What remains, the line the kernel draws for an unprivileged program: the moments between `execve` and this call. A
 * process that started the program (its parent may also trace it under Yama's default scope) or races its start can
 * still take a handle in them; executing the program again after turning private would not help, since every
 * `execve` makes the process readable again until its new image runs this call. So whoever starts the program can run
 * code in it (docs/llms/40); its registration key, which never leaves its memory and loopback, is that process's own
 * only as far as that holds.
 */
import { keepProcessPrivate } from './process-privacy.js';

keepProcessPrivate();

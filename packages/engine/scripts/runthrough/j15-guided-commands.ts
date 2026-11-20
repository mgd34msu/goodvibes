/**
 * Journey 15: a described command's guided path, in both terminal programs.
 *
 *  - the real TUI and the real Agent run in a pseudo-terminal (pty.ts) on the
 *    journey's daemon, with one stdio MCP stand-in configured;
 *  - bare `/mcp` opens the grouped first screen ("See your servers",
 *    "Add a server…", the two group rows);
 *  - "Add a server…" opens its form at step 1 of 2; typing a command fills
 *    `Command`, suggests `Name`, and the form's live line reads
 *    `This will run: /mcp add <name> -- <command>`;
 *  - Enter twice and the sentence's button add it; the done line names the
 *    command for it, and the server is in the project's MCP config.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENTRY, TUI_ENTRY, Journey, short, stage } from './lib.ts';
import { openTerminalApp } from './pty.ts';

const journey = new Journey('j15-guided-commands');
const s = await stage('j15');

/**
 * The screen as it stands, replayed from everything written: the renderer
 * writes only the cells that changed, so a phrase redrawn over similar text
 * is never in the stream whole. Cursor moves, clears and text are applied;
 * colours and other sequences are skipped. 120x40, as pty.ts opens it.
 */
function screenNow(raw: string, cols = 120, rows = 40): string {
  const grid = Array.from({ length: rows }, () => Array<string>(cols).fill(' '));
  let x = 0;
  let y = 0;
  for (let i = 0; i < raw.length;) {
    const ch = raw[i]!;
    if (ch === '\x1b') {
      const csi = /^\x1b\[([0-?]*)[ -/]*([@-~])/.exec(raw.slice(i, i + 32));
      if (csi) {
        const args = csi[1]!.split(';').map((n) => Number.parseInt(n, 10));
        const n = Number.isNaN(args[0]!) ? 1 : args[0]!;
        if (csi[2] === 'H' || csi[2] === 'f') { y = (Number.isNaN(args[0]!) ? 1 : args[0]!) - 1; x = (Number.isNaN(args[1] ?? Number.NaN) ? 1 : args[1]!) - 1; }
        else if (csi[2] === 'C') x += n;
        else if (csi[2] === 'D') x -= n;
        else if (csi[2] === 'A') y -= n;
        else if (csi[2] === 'B') y += n;
        else if (csi[2] === 'G') x = n - 1;
        else if (csi[2] === 'J' && args[0] === 2) for (const row of grid) row.fill(' ');
        else if (csi[2] === 'K') grid[y]?.fill(' ', x);
        i += csi[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(raw.slice(i, i + 512));
      i += osc ? osc[0].length : 2;
      continue;
    }
    const cp = raw.codePointAt(i)!;
    const text = String.fromCodePoint(cp);
    i += text.length;
    if (ch === '\r') { x = 0; continue; }
    if (ch === '\n') { y += 1; continue; }
    if (cp < 0x20 || cp === 0x7f) continue;
    if (y >= 0 && y < rows && x >= 0 && x < cols) grid[y]![x] = text;
    x += 1;
  }
  return grid.map((row) => row.join('').trimEnd()).join('\n');
}

/** Wait until the replayed screen matches. */
async function waitForScreen(raw: () => string, pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = screenNow(raw()).match(pattern);
    if (found || Date.now() > deadline) return found;
    await Bun.sleep(100);
  }
}

/** A stdio MCP stand-in with one tool. */
const STANDIN = `
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let b = '';
process.stdin.on('data', (c) => { b += c; let i; while ((i = b.indexOf('\\n')) >= 0) { const l = b.slice(0, i); b = b.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'weather', version: '1' } } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'forecast', description: 'Tomorrow', inputSchema: { type: 'object', properties: {} } }] } });
  else if (m.id !== undefined) send({ id: m.id, result: {} }); } });`;

try {
  const standin = join(s.home.root, 'weather-mcp.js');
  writeFileSync(standin, STANDIN);
  for (const [program, entry] of [['tui', TUI_ENTRY], ['agent', AGENT_ENTRY]] as const) {
    // Bun's transpiler cache is off: two programs compiling the same changed sources at once have crashed Bun itself.
    const app = openTerminalApp([process.execPath, '--no-env-file', entry], { cwd: s.home.workspace, env: { ...s.home.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' } });
    try {
      await app.waitFor(/\S{3,}/, 20_000);
      // The Agent opens on its workspace; Esc returns to the composer.
      if (program === 'agent') { app.press('\x1b'); app.press('\x1b'); }
      let mark = app.raw().length;
      await app.type('/mcp');
      app.press('\r');
      const first = await app.waitFor(/See your servers[\s\S]*Add a server…[\s\S]*Choose what a server may do…[\s\S]*Check a server that isn't working…/, 15_000, mark);
      journey.check(`${program}: bare /mcp opens the grouped first screen`, '/mcp, Enter', short(first?.[0] ?? app.screen().slice(-400), 240), first !== null);

      mark = app.raw().length;
      app.press('\x1b[B'); // Down to "Add a server…"
      app.press('\r');
      await app.type(`bun ${standin}`);
      const form = await waitForScreen(app.raw, /Add a server · step 1 of 2[\s\S]*weather\s+suggested from the command[\s\S]*This will run: \/mcp add weather -- bun /, 15_000);
      journey.check(`${program}: the add form suggests the name and shows the line it will run`, 'Down, Enter, type the command',
        short(form?.[0] ?? screenNow(app.raw()).slice(-600), 240), form !== null);

      mark = app.raw().length;
      app.press('\r'); // step 2
      app.press('\r'); // done: the sentence
      await app.waitFor(/weather will be added/, 10_000, mark);
      app.press('\r'); // the confirming button (chosen first for a change with no risk)
      const done = await app.waitFor(/Added weather\.[\s\S]*The command for this is: \/mcp add weather -- bun/, 15_000, mark);
      const config = join(s.home.workspace, '.goodvibes', 'mcp.json');
      const kept = existsSync(config) && readFileSync(config, 'utf8').includes('"weather"');
      journey.check(`${program}: the action runs, says what it did and the line, and keeps the server`, 'Enter, Enter, choose Add',
        `${short(done?.[0] ?? app.screen().slice(-300), 200)}; in ${config}: ${kept}`, done !== null && kept);
      // The next program adds the same server again from a clean config.
      if (existsSync(config)) writeFileSync(config, '{ "servers": [] }\n');
    } finally {
      await app.close();
    }
  }
} catch (error) {
  journey.check('journey ran to the end', 'j15', error instanceof Error ? error.stack ?? error.message : String(error), false);
} finally {
  await s.close();
}
journey.finish(s.base);

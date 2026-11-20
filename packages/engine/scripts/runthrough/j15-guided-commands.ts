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
      const form = await app.waitFor(/Add a server · step 1 of 2[\s\S]*suggested from the command[\s\S]*This will run:[\s\S]*\/mcp add weather/, 15_000, mark);
      journey.check(`${program}: the add form suggests the name and shows the line it will run`, 'Down, Enter, type the command',
        short(form?.[0] ?? app.screen().slice(-400), 240), form !== null);

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

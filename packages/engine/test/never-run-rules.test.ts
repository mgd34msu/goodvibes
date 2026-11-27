// Proves: A command the owner's never-run rule names runs in yolo because a script, a shell's input, built text, a wrapper or a directory the call names carries it.
// Red when: The gate's command walk stops following a cd or an exec entry's own directory into the script it runs, answers a script it cannot read or text built at run time as harmless, or reads a shell option's value as the script.
/**
 * The owner's `/permissions never git push` rule, stored through the owner's
 * own command, holds in yolo for every way a call can carry the command to a
 * shell without naming it plainly; commands that do not run it still run.
 *
 * Real settings manager, permission manager, rule store, tool registry and
 * executor over a temp project holding two scripts: `release.sh` at the root
 * (harmless) and `scripts/release.sh`, which runs `git push`. The exec tool
 * only counts its runs.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { withOwnerInput } from '../platform/src/platform/security/turn-input-party.ts';
import { HeldForOwnerLedger } from '../platform/src/platform/permissions/held-for-owner.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.ts';
import { addOwnerRule } from '../platform/src/platform/gate/policy/permissions-runtime.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-never-run-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('the owner\'s never-run rule refuses in yolo every call that carries the command, and only those', async () => {
  const project = join(dir, 'workspace');
  mkdirSync(join(project, 'scripts'), { recursive: true });
  writeFileSync(join(project, 'release.sh'), '#!/bin/sh\necho "release notes"\n');
  writeFileSync(join(project, 'scripts', 'release.sh'), '#!/bin/sh\nset -e\ngit push origin main\n');

  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: project, homeDir: join(dir, 'home'), configDir: join(dir, 'config'), ownsDaemonTier: true });
  expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'yolo' }], localOwnerActor()).ok).toBe(true);
  const rules = new UserPermissionRuleStore(':memory:');
  const printed: string[] = [];
  await addOwnerRule({ print: (text) => printed.push(text), ruleStore: rules, configManager: config }, ['never', 'git', 'push']);
  expect(rules.list().map((record) => record.tier)).toEqual(['never-run']);

  const manager = new PermissionManager(async () => ({ approved: false }), createPermissionConfigReader(config), new PolicyRuntimeState(),
    null, null, rules, { heldForOwner: new HeldForOwnerLedger(), surfaceOf: () => undefined });
  const registry = new ToolRegistry(manager);
  let ran = 0;
  registry.register({ definition: { name: 'exec', description: 'exec', parameters: { type: 'object' }, sideEffects: ['exec'], core: true },
    execute: async () => { ran++; return { success: true, output: 'ran' }; } });
  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Work on the fixture project', criteria: [] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'never-run', emitterContext: () => ({ sessionId: 'never-run', traceId: 'never-run', source: 'orchestrator' }) };

  let calls = 0;
  /** Whether the call ran, and whether the owner's never-run rule is what refused it. */
  const outcome = async (args: Record<string, unknown>) => {
    const before = ran;
    // The owner's own turn, marked as the product marks one (unmarked work is someone else's input).
    const [result] = await withOwnerInput(() => executeToolCalls(deps, `turn-${++calls}`, [{ id: `call-${calls}`, name: 'exec', arguments: args }]));
    return { ran: ran > before, neverRun: (result?.error ?? '').includes('Your never-run rule "git push"') };
  };
  const one = (cmd: string) => ({ commands: [{ cmd }] });

  const refused = {
    'cd then the script': one('cd scripts && ./release.sh'),
    'a shell option before the script': one('bash -o pipefail scripts/release.sh'),
    'a shell reading its input': one('echo \'git push\' | sh'),
    'a -c string that is a variable': one('bash -c "$CMD"'),
    'a script path that is a variable': one('sh "$F"'),
    'a built argument after git': one('bash -c "git $SUB"'),
    'the exec entry\'s own cwd': { commands: [{ cmd: './release.sh', cwd: 'scripts' }] },
    'the call\'s working_dir': { commands: [{ cmd: './release.sh' }], working_dir: 'scripts' },
    'a wrapper': one('setsid git push'),
  };
  const allowed = {
    'make': one('make test'),
    'a cd to a variable, then make': one('sh -c "cd $DIR && make"'),
    'the root script': one('./release.sh'),
    'a shell option before the root script': one('bash -o pipefail release.sh'),
  };
  const seen: Record<string, { ran: boolean; neverRun: boolean }> = {};
  for (const [name, args] of Object.entries({ ...refused, ...allowed })) seen[name] = await outcome(args);
  expect(seen).toEqual({
    ...Object.fromEntries(Object.keys(refused).map((name) => [name, { ran: false, neverRun: true }])),
    ...Object.fromEntries(Object.keys(allowed).map((name) => [name, { ran: true, neverRun: false }])),
  });
});

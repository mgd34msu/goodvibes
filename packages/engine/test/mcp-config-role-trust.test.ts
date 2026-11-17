/**
 * Changing what an MCP server may do (its trust mode, its role, or releasing
 * it from quarantine) is the owner's decision. In `jev-decides`, where Jev
 * settles ordinary calls, these go to the owner and the owner's answer, yes or
 * no, is the outcome; in `just-vibes` they are held for the owner, never
 * approved on the way. Jev is a fixture port that reads every call as
 * harmless, so Jev never stands in the way of an approval here.
 *
 * The server file is the other way in: a trust mode or role the permission
 * manager does not implement is dropped on load, so a typo cannot reach it as
 * an unknown mode, and writing one is refused.
 *
 * Real settings manager, permission manager and MCP config loader over temp
 * directories.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { loadMcpConfig, upsertMcpServerConfig } from '../platform/src/platform/mcp/config.ts';
import { PermissionManager, createPermissionConfigReader } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { READ_ONLY, useGateReadings } from './_helpers/gate-readings.ts';

useGateReadings([['"mcp"', READ_ONLY]]);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-mcp-trust-')));
  roots.push(root);
  return root;
}

/** A permission manager in `mode` with a working decision model, and a log of what the owner was asked. */
function gate(mode: 'jev-decides' | 'just-vibes', ownerAnswer = false) {
  const root = tempRoot();
  const config = new ConfigManager({ configDir: join(root, 'config'), workingDir: root, surfaceRoot: 'goodvibes' });
  config.set('judgment.endpoint', 'http://127.0.0.1:9/v1');
  config.set('judgment.model', 'fixture-model');
  config.set('judgment.keySource', 'none');
  config.set('permissions.mode', mode);
  const asked: string[] = [];
  const permissions = new PermissionManager(async (request) => {
    asked.push(String((request as { args?: { mode?: unknown } }).args?.mode));
    return { approved: ownerAnswer };
  }, createPermissionConfigReader(config), new PolicyRuntimeState());
  expect(permissions.getMode()).toBe(mode);
  return { permissions, asked };
}

const TRUST_CHANGES = [
  { mode: 'set-trust', serverName: 'files', trustMode: 'allow-all' },
  { mode: 'set-role', serverName: 'files', role: 'deploy' },
  { mode: 'approve-quarantine', serverName: 'files' },
] as const;

describe('changing an MCP server\'s trust is the owner\'s decision', () => {
  test('in jev-decides, each trust change is put to the owner and the owner\'s answer is the outcome', async () => {
    for (const ownerAnswer of [false, true]) {
      const { permissions, asked } = gate('jev-decides', ownerAnswer);
      for (const change of TRUST_CHANGES) {
        expect((await permissions.checkDetailed('mcp', { ...change })).approved, change.mode).toBe(ownerAnswer);
      }
      expect(asked).toEqual(TRUST_CHANGES.map((change) => change.mode));
    }
  });

  test('in just-vibes, a trust change is held for the owner, not approved', async () => {
    const { permissions, asked } = gate('just-vibes');
    for (const change of TRUST_CHANGES) {
      const result = await permissions.checkDetailed('mcp', { ...change });
      expect(result.approved, change.mode).toBe(false);
      expect(result.decision?.state, change.mode).toBe('queued-for-owner');
    }
    expect(asked).toEqual([]);
  });
});

describe('the MCP server file', () => {
  function workspace(file: unknown) {
    const base = tempRoot();
    const home = join(base, 'home');
    const cwd = join(base, 'project');
    mkdirSync(join(cwd, '.goodvibes'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(cwd, '.goodvibes', 'mcp.json'), JSON.stringify(file));
    return { homeDirectory: home, workingDirectory: cwd };
  }

  test('a trust mode or role the manager does not implement is dropped on load, in both file formats', () => {
    const config = loadMcpConfig(workspace({ mcpServers: {
      good: { command: 'good-mcp', role: 'filesystem', trustMode: 'constrained' },
      typo: { command: 'typo-mcp', role: 'filesystems', trustMode: 'allowall' },
    } }));
    const byName = new Map(config.servers.map((server) => [server.name, server]));
    expect(byName.get('good')?.trustMode).toBe('constrained');
    expect(byName.get('typo')?.role).toBeUndefined();
    expect(byName.get('typo')?.trustMode).toBeUndefined();
    const listed = loadMcpConfig(workspace({ servers: [{ name: 'typo', command: 'typo-mcp', trustMode: 'trusted' }] }));
    expect(listed.servers[0]?.trustMode).toBeUndefined();
  });

  test('writing a server with an unknown trust mode is refused', () => {
    const paths = workspace({ servers: [] });
    expect(() => upsertMcpServerConfig(paths, 'project', { name: 'x', command: 'x-mcp', args: [], trustMode: 'allowall' as never })).toThrow();
  });
});

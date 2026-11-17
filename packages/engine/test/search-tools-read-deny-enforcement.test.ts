/**
 * When the owner denies reads, the search and map tools do not read for the
 * agent either: the find tool's content search and the repository map return
 * no file text and no exported names. The same tools over the same files
 * return them before the owner's setting, so the proof is not vacuous.
 *
 * The decision is the real one the products wire into these tools
 * (`PermissionManager.readAccess`, runtime/client-services.ts) over a real
 * settings manager in a temp directory; the owner writes
 * `permissions.tools.read` as the settings screen does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { PermissionManager, createPermissionConfigReader } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import type { ReadAccessFilter } from '../platform/src/platform/tools/shared/read-access.ts';
import { createFindTool } from '../platform/src/platform/tools/find/executor.ts';
import { createRepoMapTool } from '../platform/src/platform/tools/repo-map/index.ts';
import { useGateReadings } from './_helpers/gate-readings.ts';

useGateReadings();

const DENIED_TEXT = 'DENIED_FILE_TEXT_7f3c';
const DENIED_EXPORT = 'deniedExportSymbol';
const OPEN_TEXT = 'OPEN_FILE_TEXT_2b9e';
const OPEN_EXPORT = 'openExportSymbol';

let root: string;
let project: string;
let deniedPath: string;
let config: ConfigManager;
let filter: ReadAccessFilter;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-search-deny-')));
  project = join(root, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  deniedPath = join(project, 'private.txt');
  writeFileSync(deniedPath, `first\n${DENIED_TEXT} here\nlast\n`);
  writeFileSync(join(project, 'public.txt'), `first\n${OPEN_TEXT} here\nlast\n`);
  writeFileSync(join(project, 'src', 'private.ts'), `export const ${DENIED_EXPORT} = '${DENIED_TEXT}';\n`);
  writeFileSync(join(project, 'src', 'public.ts'), `export const ${OPEN_EXPORT} = 1;\n`);

  config = new ConfigManager({ configDir: join(root, 'config'), workingDir: project, surfaceRoot: 'goodvibes' });
  const permissions = new PermissionManager(async () => ({ approved: false }), createPermissionConfigReader(config), new PolicyRuntimeState());
  // The same adapter the products wire into these tools.
  filter = async (path) => (await permissions.readAccess(path)) === 'allow';
});

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

async function contentSearch(pattern: string): Promise<string> {
  const result = await createFindTool(project, null, undefined, filter).execute({ queries: [{ id: 'q', mode: 'content', pattern, path: '.' }] });
  expect(result.success).toBe(true);
  return String(result.output);
}

async function mapOutput(): Promise<string> {
  const result = await createRepoMapTool({ projectRoot: project, readAccessFilter: filter }).execute({});
  expect(result.success).toBe(true);
  return String(result.output);
}

describe('reads the owner denied are not made through search tools', () => {
  test('before the owner denies reads, the same searches return the text and the exports', async () => {
    expect(await filter(deniedPath)).toBe(true);
    expect(await contentSearch(DENIED_TEXT)).toContain(DENIED_TEXT);
    expect(await mapOutput()).toContain(DENIED_EXPORT);
  });

  test('after the owner denies reads, no search or map returns file text or exports', async () => {
    config.set('permissions.tools.read', 'deny');
    expect(await filter(deniedPath)).toBe(false);
    const found = await contentSearch('_FILE_TEXT_');
    expect(found).not.toContain(DENIED_TEXT);
    expect(found).not.toContain(OPEN_TEXT);
    const map = await mapOutput();
    expect(map).not.toContain(DENIED_EXPORT);
    expect(map).not.toContain(OPEN_EXPORT);
    expect(map).not.toContain(DENIED_TEXT);
  });
});

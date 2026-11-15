import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { prepareNativeBuildAssets, probeInstalledNativeBuildAssets } from '../../../scripts/build-native-ci.ts';

const require = createRequire(resolve(import.meta.dir, '../../../../../packages/engine/package.json'));
const grammars = ['tree-sitter-typescript/tree-sitter-typescript.wasm', 'tree-sitter-typescript/tree-sitter-tsx.wasm',
  'tree-sitter-javascript/tree-sitter-javascript.wasm', 'tree-sitter-python/tree-sitter-python.wasm',
  'tree-sitter-json/tree-sitter-json.wasm', 'tree-sitter-css/tree-sitter-css.wasm'];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-grammar-recovery-')); roots.push(root);
  const engine = join(root, 'packages/engine'), modules = join(engine, 'node_modules');
  const grammar = modules;
  for (const name of new Set(grammars.map(file => file.split('/')[0]!))) {
    mkdirSync(join(modules, name), { recursive: true });
    writeFileSync(join(modules, name, 'package.json'), JSON.stringify({ name }));
  }
  writeFileSync(join(engine, 'package.json'), '{"name":"owned-grammar-fixture","type":"module"}');
  symlinkSync(dirname(require.resolve('web-tree-sitter/web-tree-sitter.wasm')), join(modules, 'web-tree-sitter'), 'dir');
  symlinkSync(dirname(dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'))), join(modules, 'onnxruntime-web'), 'dir');
  symlinkSync(dirname(dirname(require.resolve('sql.js/dist/sql-wasm.wasm'))), join(modules, 'sql.js'), 'dir');
  const entry = join(engine, 'entry.ts');
  const program = grammars.map((file, index) => `import grammar${index} from '${file}' with { type: 'file' };`).join('\n')
    + `\nexport const embedded = [${grammars.map((_, index) => `grammar${index}`).join(', ')}];`;
  writeFileSync(entry, program);
  let builds = 0, installs = 0;
  const restore = () => { for (const file of grammars) copyFileSync(require.resolve(file), join(grammar, file)); };
  const build = async () => {
    builds++;
    const result = spawnSync(process.execPath, ['build', entry, '--target=bun', '--outdir', join(root, 'output')], { encoding: 'utf8', timeout: 10_000 });
    if (result.error) throw result.error;
    if (result.signal || result.status === null) throw new Error('Fixture compiler was interrupted');
    return { exitCode: result.status, output: `${result.stdout}\n${result.stderr}` };
  };
  const effects = { install: async () => { installs++; restore(); }, report: (_message: string) => {} };
  return { root, grammar, restore, build, effects, counts: () => ({ builds, installs }) };
}

function preparation(f: ReturnType<typeof fixture>, install = f.effects.install) {
  let probes = 0;
  return {
    effects: { probe: async () => { probes++; await probeInstalledNativeBuildAssets(f.root); }, install, report: f.effects.report },
    probes: () => probes,
  };
}

test('native preflight leaves a complete actual installation untouched and does not compile', async () => {
  const f = fixture(); f.restore(); const ready = preparation(f);
  await prepareNativeBuildAssets(ready.effects);
  expect(ready.probes()).toBe(1); expect(f.counts()).toEqual({ builds: 0, installs: 0 });
});

test('native preflight repairs missing JSON once, then parses every real language before compilation', async () => {
  const f = fixture(); f.restore(); const ready = preparation(f);
  rmSync(join(f.grammar, 'tree-sitter-json/tree-sitter-json.wasm'));
  await prepareNativeBuildAssets(ready.effects);
  expect(ready.probes()).toBe(2); expect(f.counts()).toEqual({ builds: 0, installs: 1 });
  expect((await f.build()).exitCode).toBe(0); expect(f.counts()).toEqual({ builds: 1, installs: 1 });
});

test('native preflight detects readable corrupt grammar content and validates its one repair', async () => {
  const f = fixture(); f.restore(); const ready = preparation(f);
  writeFileSync(join(f.grammar, 'tree-sitter-json/tree-sitter-json.wasm'), 'not a grammar');
  await prepareNativeBuildAssets(ready.effects);
  expect(ready.probes()).toBe(2); expect(f.counts()).toEqual({ builds: 0, installs: 1 });
});

test('a failed native dependency install stops before a second probe or compilation', async () => {
  const f = fixture(); let installs = 0;
  const ready = preparation(f, async () => { installs++; throw new Error('frozen install refused'); });
  await expect(prepareNativeBuildAssets(ready.effects)).rejects.toThrow('frozen install refused');
  expect(installs).toBe(1); expect(ready.probes()).toBe(1); expect(f.counts().builds).toBe(0);
});

test('a native repair that leaves missing assets fails closed without repeated repair or compilation', async () => {
  const f = fixture(); let installs = 0;
  const ready = preparation(f, async () => { installs++; });
  await expect(prepareNativeBuildAssets(ready.effects)).rejects.toThrow('Installed native build asset validation failed');
  expect(installs).toBe(1); expect(ready.probes()).toBe(2); expect(f.counts().builds).toBe(0);
});

for (const missing of ['onnxruntime-web/ort-wasm-simd-threaded.mjs', 'onnxruntime-web/ort-wasm-simd-threaded.wasm', 'sql.js/dist/sql-wasm.wasm']) {
  test(`native preflight refuses the exact missing required asset ${missing}`, async () => {
    const f = fixture(); f.restore();
    const packageName = missing.split('/')[0]!;
    const packageDirectory = join(f.grammar, packageName);
    rmSync(packageDirectory); mkdirSync(packageDirectory);
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ name: packageName }));
    for (const file of ['onnxruntime-web/ort-wasm-simd-threaded.mjs', 'onnxruntime-web/ort-wasm-simd-threaded.wasm', 'sql.js/dist/sql-wasm.wasm']) {
      if (!file.startsWith(`${packageName}/`) || file === missing) continue;
      const path = join(f.grammar, file); mkdirSync(dirname(path), { recursive: true }); copyFileSync(require.resolve(file), path);
    }
    const ready = preparation(f);
    await expect(prepareNativeBuildAssets(ready.effects)).rejects.toThrow('Installed native build asset validation failed');
    expect(ready.probes()).toBe(2); expect(f.counts()).toEqual({ builds: 0, installs: 1 });
  });
}

test('a retained helper probes the selected checkout even outside that checkout', async () => {
  const f = fixture(); f.restore();
  const retained = join(f.root, 'retained-tooling'); mkdirSync(retained);
  const helper = join(retained, 'build-native-ci.ts');
  copyFileSync(resolve(import.meta.dir, '../../../scripts/build-native-ci.ts'), helper);
  copyFileSync(resolve(import.meta.dir, '../../../scripts/native-execution-process.mjs'), join(retained, 'native-execution-process.mjs'));
  const retainedModule = await import(helper);
  await retainedModule.prepareNativeBuildAssets({
    probe: () => retainedModule.probeInstalledNativeBuildAssets(f.root),
    install: async () => { throw new Error('A complete selected checkout must not be reinstalled'); },
    report: (_message: string) => {},
  });
  expect(f.counts()).toEqual({ builds: 0, installs: 0 });
});

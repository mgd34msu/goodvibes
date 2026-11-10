import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { buildWithGrammarRecovery, prepareNativeBuildAssets, probeInstalledNativeBuildAssets, probeInstalledNativeGrammars } from '../../../scripts/build-native-ci.ts';

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
  const effects = {
    build, probe: () => probeInstalledNativeGrammars(root),
    install: async () => { installs++; restore(); }, report: (_message: string) => {},
  };
  return { root, grammar, entry, program, restore, build, effects, counts: () => ({ builds, installs }) };
}

test('a successful real grammar bundle needs no reinstall or second build', async () => {
  const f = fixture(); f.restore();
  await buildWithGrammarRecovery(f.effects);
  await probeInstalledNativeGrammars(f.root);
  expect(f.counts()).toEqual({ builds: 1, installs: 0 });
});

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

test('suite release retains its helper before payload checkout and awaits preflight before its first TUI build', () => {
  const root = resolve(import.meta.dir, '../../../../..');
  const workflow = readFileSync(join(root, '.github/workflows/suite-release-assets.yml'), 'utf8');
  const retained = workflow.indexOf('cp products/daemon/scripts/build-native-ci.ts "$RUNNER_TEMP/build-native-ci.ts"');
  expect(retained).toBeGreaterThan(0);
  expect(retained).toBeLessThan(workflow.indexOf('ref: ${{ inputs.candidate-source || inputs.tag }}'));
  const coordinator = readFileSync(join(root, '.github/scripts/package-suite-release.mjs'), 'utf8');
  const preflight = coordinator.indexOf('await prepareNativeBuildAssets(');
  expect(preflight).toBeGreaterThan(0); expect(preflight).toBeLessThan(coordinator.indexOf("[['tui', 'goodvibes', 'dist']"));
  expect(coordinator).toContain("['install', '--frozen-lockfile', '--force']");
});

test('a retained helper probes the selected checkout even outside that checkout', async () => {
  const f = fixture(); f.restore();
  const retained = join(f.root, 'retained-tooling'); mkdirSync(retained);
  const helper = join(retained, 'build-native-ci.ts');
  copyFileSync(resolve(import.meta.dir, '../../../scripts/build-native-ci.ts'), helper);
  const retainedModule = await import(helper);
  await retainedModule.prepareNativeBuildAssets({
    probe: () => retainedModule.probeInstalledNativeBuildAssets(f.root),
    install: async () => { throw new Error('A complete selected checkout must not be reinstalled'); },
    report: (_message: string) => {},
  });
  expect(f.counts()).toEqual({ builds: 0, installs: 0 });
});

test('missing grammar assets receive one repair, actual TS/TSX parsing, and a successful fresh bundle', async () => {
  const f = fixture();
  await buildWithGrammarRecovery(f.effects);
  expect(f.counts()).toEqual({ builds: 2, installs: 1 });
});

test('grammars that become readable after failure are validated without reinstalling', async () => {
  const f = fixture();
  await buildWithGrammarRecovery({ ...f.effects, build: async () => {
    const result = await f.build(); if (f.counts().builds === 1) f.restore(); return result;
  } });
  expect(f.counts()).toEqual({ builds: 2, installs: 0 });
});

test('real syntax errors never trigger dependency repair or a repeated build', async () => {
  const f = fixture(); f.restore(); writeFileSync(f.entry, 'export const = ;');
  await expect(buildWithGrammarRecovery(f.effects)).rejects.toThrow('without a recoverable grammar error');
  expect(f.counts()).toEqual({ builds: 1, installs: 0 });
});

test('a grammar resolution error cannot conceal a different unresolved dependency', async () => {
  const f = fixture(); writeFileSync(f.entry, `${f.program}\nimport './unavailable.ts';`);
  await expect(buildWithGrammarRecovery(f.effects)).rejects.toThrow('without a recoverable grammar error');
  expect(f.counts()).toEqual({ builds: 1, installs: 0 });
});

test('replacement files that are not real grammars cannot authorize another build', async () => {
  const f = fixture();
  await expect(buildWithGrammarRecovery({ ...f.effects, install: async () => {
    await f.effects.install(); for (const file of grammars) writeFileSync(join(f.grammar, file), 'not wasm');
  } })).rejects.toThrow();
  expect(f.counts()).toEqual({ builds: 1, installs: 1 });
});

test('a repeated real resolution failure stops after the single recovery attempt', async () => {
  const f = fixture();
  await expect(buildWithGrammarRecovery({ ...f.effects, build: async () => {
    if (f.counts().builds === 1) rmSync(join(f.grammar, grammars[0]!));
    return f.build();
  } })).rejects.toThrow('single recovery attempt');
  expect(f.counts()).toEqual({ builds: 2, installs: 1 });
});

test('a missing JSON grammar receives the same bounded repair as TypeScript', async () => {
  const f = fixture(); f.restore();
  rmSync(join(f.grammar, 'tree-sitter-json/tree-sitter-json.wasm'));
  await buildWithGrammarRecovery(f.effects);
  expect(f.counts()).toEqual({ builds: 2, installs: 1 });
});

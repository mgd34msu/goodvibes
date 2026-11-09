/** Ownership regressions, authored and UNRUN during coding first. */
import { expect, test } from 'bun:test';
import { discoverGlobalPackageOwner } from '../platform/src/platform/runtime/global-package-owner.ts';
import { quoteShadowArgument, removableShadows, scanCommandShadows, splitPathEntries, type ShadowScanInput } from '../platform/src/platform/runtime/path-shadow.ts';
import { fallbackUpdateCommand } from '../platform/src/platform/runtime/install-kind.ts';
const home = '/home/owner', install = `${home}/.local/bin`, earlier = `${home}/earlier/goodvibes`;
function scan(target: string, overrides: Partial<ShadowScanInput> = {}) {
  return scanCommandShadows({ commands: ['goodvibes'], installDir: install, pathEntries: [`${home}/earlier`, install], homeDir: home,
    isExecutableFile: () => true, realPath: path => path === earlier ? target : path, probeVersion: () => 'goodvibes 2.0.25', ...overrides });
}
test('matching old product dependency is not removable without actual global-manager evidence', () => {
  expect(removableShadows(scan(`${home}/project/node_modules/@pellux/goodvibes-tui/bin/goodvibes`))).toEqual([]);
});
test('foreign and private package banners do not become standalone removal', () => {
  for (const name of ['@goodvibes-jev/tui', '@pellux/goodvibes-extra', '@other/tool']) {
    expect(removableShadows(scan(`${home}/global/node_modules/${name}/bin/goodvibes`, {
      probeVersion: () => { throw Error('foreign packages must not be executed to classify ownership'); },
      globalPackageOwner: () => { throw Error('no manager discovery for foreign packages'); },
    }))).toEqual([]);
  }
});
test('failed version evidence never grants package removal', () => {
  expect(removableShadows(scan(`${home}/global/node_modules/@pellux/goodvibes-tui/bin/goodvibes`, {
    probeVersion: () => undefined, globalPackageOwner: () => { throw Error('not reached'); },
  }))).toEqual([]);
});
test('failed physical resolution cannot authorize deleting the original PATH entry', () => {
  expect(removableShadows(scan(earlier, { realPath: () => { throw Error('unresolved'); } }))).toEqual([]);
});
test('an alias of the maintained executable is not a removable shadow', () => {
  expect(scan(`${install}/goodvibes`).hasProblem).toBe(false);
});
test('literal whitespace in PATH names is preserved', () => {
  expect(splitPathEntries('/home/owner/ padded :/home/owner/bin')).toEqual(['/home/owner/ padded ', '/home/owner/bin']);
});
test('shell argument display retains metacharacters and apostrophes as data', () => {
  expect(quoteShadowArgument("/home/o'w/$(touch pwned);file")).toBe("'/home/o'\\''w/$(touch pwned);file'");
  expect(removableShadows(scan(`${home}/standalone/goodvibes`, { pathEntries: [`${home}/odd name;$(touch pwned)`, install],
    realPath: path => path === `${install}/goodvibes` ? path : `${home}/standalone/goodvibes` }))[0]?.removal?.command)
    .toBe(`rm -- '${home}/odd name;$(touch pwned)/goodvibes'`);
});
test('actual npm root and prefix must agree, and nested/local dependencies never identify a global owner', () => {
  const run = (program: string, args: readonly string[]) => program === 'npm'
    ? args[0] === 'root' ? `${home}/npm/lib/node_modules` : `${home}/npm` : undefined;
  expect(discoverGlobalPackageOwner('@pellux/goodvibes-tui', `${home}/npm/lib/node_modules/@pellux/goodvibes-tui`, run, p => p))
    .toEqual({ manager: 'npm', root: `${home}/npm/lib/node_modules`, prefix: `${home}/npm` });
  expect(discoverGlobalPackageOwner('@pellux/goodvibes-tui', `${home}/project/node_modules/@pellux/goodvibes-tui`, run, p => p)).toBeUndefined();
  expect(discoverGlobalPackageOwner('@pellux/goodvibes-tui', `${home}/npm/lib/node_modules/outer/node_modules/@pellux/goodvibes-tui`, run, p => p)).toBeUndefined();
});
test('custom Bun global directories use actual manager observations and retain spaces', () => {
  const project = `${home}/custom global `, bin = `${home}/custom bin `;
  const run = (program: string, args: readonly string[]) => program !== 'bun' ? undefined
    : args[1] === 'ls' ? `${project} node_modules (1 installed)\n└── @pellux/goodvibes-tui@2.0.25` : bin;
  expect(discoverGlobalPackageOwner('@pellux/goodvibes-tui', `${project}/node_modules/@pellux/goodvibes-tui`, run, p => p))
    .toEqual({ manager: 'bun', root: `${project}/node_modules`, bin });
});
test('current private products and identified old products upgrade through the released suite installer', () => {
  for (const name of ['@goodvibes-jev/tui', '@goodvibes-jev/agent', '@goodvibes-jev/daemon', '@pellux/goodvibes-tui']) {
    expect(fallbackUpdateCommand('bun-global-package', name)).toBe('curl -fsSL https://goodvibes.sh/install.sh | sh');
  }
});

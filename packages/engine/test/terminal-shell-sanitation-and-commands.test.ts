import { describe, expect, test } from 'bun:test';
import { beadBody, cellText } from '../terminal-shell/src/renderer/bead.js';
import { parseNpmPackJson } from '../terminal-shell/src/npm-pack-report.js';
import { createRecallBundleCommands } from '../terminal-shell/src/recall-bundle.js';
import { createRecallCaptureCommands } from '../terminal-shell/src/recall-capture.js';
import { createRecallQueryCommands } from '../terminal-shell/src/recall-query.js';
import { presentRecommendedActions } from '../terminal-shell/src/provider-account-actions.js';
import { ensureBootModelResolvable } from '../terminal-shell/src/provider-boot.js';
import { ProfilePickerModal } from '../terminal-shell/src/profile-picker-state.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('terminal text sanitation', () => {
  test('C1 controls (one-character CSI and OSC) are removed from cell text', () => {
    const cleaned = cellText('a\u009bb\u009dc\u0090d\u0085e');
    expect(/[\u0080-\u009f]/.test(cleaned)).toBe(false);
    expect(cleaned.startsWith('a')).toBe(true);
    expect(cleaned.endsWith('e')).toBe(true);
  });

  test('a diff body that carries C1 controls reaches the terminal without them', () => {
    const diff = ['--- a/f.ts', '+++ b/f.ts', '@@ -1 +1 @@', '-old', '+new\u009b2J'].join('\n');
    const body = beadBody({ id: 'c1', name: 'edit', arguments: { path: 'f.ts' } }, 'ok', diff);
    expect(body?.kind).toBe('diff');
    if (body?.kind === 'diff') {
      expect(body.diff).toContain('+new');
      expect(body.diff).not.toContain('\u009b');
    }
  });
});

describe('npm pack report', () => {
  const report = JSON.stringify([{ files: [{ path: 'package.json' }], entryCount: 1, unpackedSize: 10 }]);
  test('bracketed wrapper text before the report does not hide it', () => {
    const parsed = parseNpmPackJson(`[notice] new npm available\n[1/3] resolving {step}\n${report}\n`);
    expect(parsed).toEqual({ files: ['package.json'], entryCount: 1, unpackedSize: 10 });
  });
  test('output with no report still names what npm printed', () => {
    expect(() => parseNpmPackJson('[notice] nothing useful')).toThrow(/unrecognized JSON shape|could not be parsed/);
  });
});

describe('recall capture', () => {
  test('capturing an mcp server does not need the forensics registry', async () => {
    const added: unknown[] = [];
    const printed: string[] = [];
    const server = { name: 'files', role: 'tool', trustMode: 'standard', connected: true, schemaFreshness: 'fresh', allowedPaths: [], allowedHosts: [] } as never;
    const commands = createRecallCaptureCommands<never>(
      () => ({ add: async (options: unknown) => { added.push(options); return { id: 'mem-1' }; } }) as never,
      { tag: '[memory]', command: 'memory' } as never,
    );
    const context = {
      print: (message: string) => printed.push(message),
      extensions: { mcpRegistry: { listServerSecurity: () => [server] } },
      session: { runtime: { sessionId: 's' } },
    } as never;
    await commands.handleRecallCapture(['mcp', 'files'], context);
    expect(printed.join('\n')).not.toContain('Forensics registry');
    expect(added).toHaveLength(1);
  });
  test('capturing an incident still reports a missing forensics registry', async () => {
    const printed: string[] = [];
    const commands = createRecallCaptureCommands<never>(
      () => ({ add: async () => ({ id: 'x' }) }) as never,
      { tag: '[memory]', command: 'memory' } as never,
    );
    await commands.handleRecallCapture(['incident'], { print: (m: string) => printed.push(m), extensions: {}, session: { runtime: {} } } as never);
    expect(printed.join('\n')).toContain('Forensics registry not available');
  });
});

describe('recall list and search arguments', () => {
  function query(records: readonly { id: string; cls: string; scope: string; tags: string[]; summary: string; createdAt: number; provenance: [] }[]) {
    const filters: unknown[] = [];
    const commands = createRecallQueryCommands<{ print: (m: string) => void }>(
      () => ({ list: async (filter: unknown) => { filters.push(filter); return records; } }) as never,
      () => null,
      {
        tag: '[memory]', command: 'memory', validValuesLabel: 'Valid:', validValuesSuffix: '.', listSuffix: '', temporal: false, originLabel: 'origin',
        provenance: () => '', provenanceEntry: () => '', label: () => '', missingSeparator: ': ', confirmMutations: false,
        printLinked() {}, printDeleted() {}, linkFailure: 'failed',
      } as never,
    );
    return { commands, filters };
  }
  const record = (id: string) => ({ id, cls: 'fact', scope: 'project', tags: [], summary: id, createdAt: 0, provenance: [] as [] });

  test('an unknown class is refused instead of listing every class', async () => {
    const { commands, filters } = query([record('a')]);
    const printed: string[] = [];
    await commands.handleRecallList(['typo'], { print: (m) => printed.push(m) });
    expect(filters).toHaveLength(0);
    expect(printed.join('\n')).toContain('Unknown class "typo"');
  });

  test('a scope value is not mistaken for the class', async () => {
    const { commands, filters } = query([record('a')]);
    await commands.handleRecallList(['--scope', 'team'], { print: () => {} });
    expect(filters[0]).toMatchObject({ scope: 'team' });
    expect(filters[0]).not.toHaveProperty('cls');
  });

  test('a full page says there may be more', async () => {
    const { commands } = query(Array.from({ length: 50 }, (_, index) => record(`r${index}`)));
    const printed: string[] = [];
    await commands.handleRecallList([], { print: (m) => printed.push(m) });
    expect(printed.join('\n')).toContain('there may be more');
  });

  test('search refuses a negative or non-numeric --limit', async () => {
    const { commands, filters } = query([record('a')]);
    const printed: string[] = [];
    await commands.handleRecallSearch(['x', '--limit', '-5'], { print: (m) => printed.push(m) });
    await commands.handleRecallSearch(['x', '--limit', 'abc'], { print: (m) => printed.push(m) });
    expect(filters).toHaveLength(0);
    expect(printed.filter((m) => m.includes('Invalid --limit'))).toHaveLength(2);
  });
});

describe('recall bundles', () => {
  function bundles(root: string, exported: unknown) {
    const printed: string[] = [];
    let imported = 0;
    const paths = {
      resolveWorkspacePath: (path: string) => resolve(root, path),
      isWithinWorkingDirectory: (path: string) => resolve(root, path).startsWith(`${root}/`),
    };
    const commands = createRecallBundleCommands<{ print: (m: string) => void; invokedByModel?: boolean }>(
      () => ({ exportBundle: () => exported, importBundle: async () => { imported += 1; return { importedRecords: 0, skippedRecords: 0, importedLinks: 0 }; } }) as never,
      () => paths as never,
      {
        tag: '[memory]', command: 'memory', validValuesLabel: 'Valid:', validValuesSuffix: '.', confirmMutations: true,
        errorSeparator: ': ', fieldSeparator: ': ', recordsLabel: '', linksLabel: '',
      },
    );
    return { commands, printed, imported: () => imported };
  }
  const bundle = { schemaVersion: 'v1', exportedAt: 1, scope: 'project', recordCount: 0, linkCount: 0, records: [], links: [] };

  test('a model-run export cannot write outside the workspace; the owner can', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-bundle-'));
    const outside = mkdtempSync(join(tmpdir(), 'recall-outside-'));
    try {
      const { commands, printed } = bundles(root, bundle);
      const target = join(outside, 'out.json');
      await commands.handleRecallExport([target, '--yes'], { print: (m) => printed.push(m), invokedByModel: true });
      expect(existsSync(target)).toBe(false);
      expect(printed.join('\n')).toContain('outside the workspace');
      await commands.handleRecallExport(['inside.json', '--yes'], { print: (m) => printed.push(m), invokedByModel: true });
      expect(existsSync(join(root, 'inside.json'))).toBe(true);
      await commands.handleRecallExport([target, '--yes'], { print: (m) => printed.push(m) });
      expect(existsSync(target)).toBe(true);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('an import that is not a memory bundle is refused before it reaches the store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recall-import-'));
    try {
      writeFileSync(join(root, 'bad.json'), '{}');
      const { commands, printed, imported } = bundles(root, bundle);
      await commands.handleRecallImport(['bad.json', '--yes'], { print: (m) => printed.push(m) });
      expect(imported()).toBe(0);
      expect(printed.join('\n')).toContain('not a memory bundle');
      writeFileSync(join(root, 'ok.json'), JSON.stringify(bundle));
      await commands.handleRecallImport(['ok.json', '--yes'], { print: (m) => printed.push(m) });
      expect(imported()).toBe(1);
      expect(readFileSync(join(root, 'ok.json'), 'utf-8')).toContain('"v1"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('provider repair actions', () => {
  test('a repair command that rejects is reported, not dropped', async () => {
    const printed: string[] = [];
    let choose: ((result: { item: { id: string } } | null) => void) | undefined;
    presentRecommendedActions(
      {
        print: (m) => printed.push(m),
        openSelection: (_title, _items, _options, onResult) => { choose = onResult as never; },
        executeCommand: () => Promise.reject(new Error('handler exploded')),
      },
      'openai',
      [{ description: 'Re-login', command: { name: 'login', args: ['openai'] } }],
    );
    choose?.({ item: { id: '0' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(printed.join('\n')).toContain('/login failed: handler exploded');
  });
});

describe('boot model substitution', () => {
  test('the saved model stays on disk and the caller is told which model is running', async () => {
    const sets: [string, unknown][] = [];
    const registry = {
      ready: async () => {},
      listModels: () => [],
      tryGet: () => undefined,
      getCurrentModel: () => { throw new Error('not in registry'); },
      getSelectableModels: () => [{ registryKey: 'builtin:fallback' }],
      setCurrentModel: (key: string) => { sets.push(['current', key]); },
    };
    const config = {
      get: () => 'custom:gone',
      set: (key: string, value: unknown) => { sets.push([key, value]); },
    };
    const substitution = await ensureBootModelResolvable(registry as never, config as never);
    expect(substitution).toEqual({ configured: 'custom:gone', replacement: 'builtin:fallback' });
    expect(sets).toEqual([['current', 'builtin:fallback']]);
  });
});

describe('profile loading', () => {
  function modal(data: unknown) {
    const picker = new ProfilePickerModal({ load: () => ({ data }), list: () => [{ name: 'work' }] } as never);
    picker.profiles = [{ name: 'work' } as never];
    return picker;
  }
  function config(reject: readonly string[]) {
    const applied: string[] = [];
    let saves = 0;
    const set = (key: string) => { if (reject.includes(key)) throw new Error('rejected'); applied.push(key); };
    return { cm: { set, setDynamic: set, save: () => { saves += 1; } } as never, applied, saves: () => saves };
  }

  test('a rejected model is named, the load is not reported as a plain success, and what applied is saved', () => {
    const picker = modal({ provider: { model: 'gone:model' }, display: { stream: false } });
    const c = config(['provider.model']);
    expect(picker.loadSelected(c.cm)).toBe(false);
    expect(picker.statusMessage).toContain('provider.model');
    expect(c.applied).toEqual(['display.stream']);
    expect(c.saves()).toBe(1);
  });

  test('nothing applied means nothing saved', () => {
    const picker = modal({ provider: { model: 'gone:model' } });
    const c = config(['provider.model']);
    expect(picker.loadSelected(c.cm)).toBe(false);
    expect(c.saves()).toBe(0);
    expect(picker.statusMessage).toContain('not loaded');
  });

  test('approval behaviour in a profile from another host is not applied', () => {
    const picker = modal({ behavior: { autoApprove: true, hitlMode: 'off', saveHistory: false } });
    const c = config([]);
    expect(picker.loadSelected(c.cm)).toBe(true);
    expect(c.applied).toEqual(['behavior.saveHistory']);
  });

  test('saving a profile leaves approval behaviour out of it', () => {
    let saved: { behavior?: Record<string, unknown> } | undefined;
    const picker = new ProfilePickerModal({ save: (_name: string, data: typeof saved) => { saved = data; }, list: () => [] } as never);
    const cm = {
      getAll: () => ({
        display: {},
        provider: { model: 'm', reasoningEffort: 'low' },
        behavior: { autoApprove: true, hitlMode: 'off', saveHistory: false },
      }),
    } as never;
    expect(picker.saveCurrentAs('work', cm)).toBe(true);
    expect(saved?.behavior).toEqual({ saveHistory: false });
  });

  test('a clean load still reports success', () => {
    const picker = modal({ display: { stream: false } });
    const c = config([]);
    expect(picker.loadSelected(c.cm)).toBe(true);
    expect(picker.statusMessage).toBe('Loaded profile: work');
  });
});

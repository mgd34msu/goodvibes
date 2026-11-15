/**
 * Resources a tool starts do not outlive their purpose: a validator runner gets
 * the call's cancel signal, spilled output is pruned and private,
 * background output spill files are capped and removed on shutdown, and a
 * cancelled web search stops being waited for.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runValidators } from '../platform/src/platform/tools/shared/validators.ts';
import { FileBackend, OverflowHandler } from '../platform/src/platform/tools/shared/overflow.ts';
import { ProcessManager, readProcessStream } from '../platform/src/platform/tools/shared/process-manager.ts';
import { createWebSearchTool } from '../platform/src/platform/tools/web-search/index.ts';
import type { WebSearchService } from '../platform/src/platform/web-search/index.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tempRoot = (): string => { const root = mkdtempSync(join(tmpdir(), 'gv-hygiene-')); roots.push(root); return root; };

test('runValidators hands the cancel signal to the runner', async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  await runValidators(['test'], tempRoot(), async (name, _cwd, execution) => {
    seen = execution?.signal;
    return { validator: name, passed: true, stdout: '', stderr: '', exitCode: 0 };
  }, () => {}, controller.signal);
  expect(seen).toBe(controller.signal);
});

test('starting the runtime prunes spilled outputs older than the retention, and keeps recent ones', () => {
  const base = tempRoot();
  const directory = join(base, '.goodvibes', '.overflow');
  mkdirSync(directory, { recursive: true });
  const old = join(directory, 'old.txt'), recent = join(directory, 'recent.txt');
  writeFileSync(old, 'old'); writeFileSync(recent, 'recent');
  const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(old, eightDaysAgo, eightDaysAgo);
  new OverflowHandler({ baseDir: base });
  expect(existsSync(old)).toBe(false);
  expect(existsSync(recent)).toBe(true);
});

test('a spilled output is readable only by its owner', () => {
  const base = tempRoot();
  const entry = new FileBackend(base).write('full.txt', 'command output');
  expect(entry).not.toBeNull();
  expect(statSync(join(base, '.goodvibes', '.overflow', 'full.txt')).mode & 0o077).toBe(0);
});

const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
});

test('background output past the spill cap stops being written, says so, and is still drained', async () => {
  const sink: string[] = [], spills: string[] = [];
  await readProcessStream(streamOf('a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10), 'd'.repeat(10)), sink, undefined, undefined, spills,
    { previewBytes: 15, spillBytes: 25 });
  const { readFileSync } = await import('node:fs');
  expect(spills).toHaveLength(1);
  roots.push(spills[0]!);
  const written = readFileSync(join(spills[0]!, 'output.log'), 'utf-8');
  expect(written).toContain('a'.repeat(10) + 'b'.repeat(10));
  expect(written).not.toContain('c'.repeat(10));
  expect(written).toContain('output limit of 25 bytes reached');
  expect(sink.join('')).toContain('output limit of 25 bytes reached');
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('shutting the process manager down removes the spill directories of finished jobs', async () => {
  const manager = new ProcessManager();
  const started = await manager.spawn("head -c 400000 /dev/zero | tr '\\0' a", undefined, undefined);
  const id = started.process_id!;
  await until(() => manager.getStatus(id)?.done === true);
  const note = manager.getOutput(id)!.stdout.match(/continues in (\S+output\.log)/);
  expect(note).not.toBeNull();
  const file = note![1]!;
  expect(existsSync(file)).toBe(true);
  await manager.close();
  expect(existsSync(file)).toBe(false);
});

test('a cancelled web search stops waiting for the provider and says it was cancelled', async () => {
  let release!: () => void;
  const service = { search: () => new Promise((_resolve, reject) => { release = () => reject(new Error('late provider failure')); }) } as unknown as WebSearchService;
  const tool = createWebSearchTool(service);
  const controller = new AbortController();
  const running = tool.execute({ query: 'anything' }, { signal: controller.signal });
  controller.abort();
  const result = await running;
  expect(result).toMatchObject({ success: false, cancelled: true });
  release();
});

test('a web search provider failure is a failed result with the reason, and maxResults is a whole number in range', async () => {
  const seen: unknown[] = [];
  const failing = { search: async (request: unknown) => { seen.push(request); throw new Error('provider down'); } } as unknown as WebSearchService;
  const failed = await createWebSearchTool(failing).execute({ query: 'q', maxResults: 99.7 });
  expect(failed).toMatchObject({ success: false });
  expect(failed.error).toContain('provider down');
  expect((seen[0] as { maxResults: number }).maxResults).toBe(25);
});

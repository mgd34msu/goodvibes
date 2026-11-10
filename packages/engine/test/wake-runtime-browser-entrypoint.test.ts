import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'bun:test';
import { withTestTimeout } from './_helpers/test-timeout.ts';

const ENGINE_ROOT = resolve(import.meta.dir, '..');
const JUDGMENT_ROOT = resolve(ENGINE_ROOT, '../judgment');
const PUBLIC_ENTRY = '@goodvibes-jev/engine/platform/platform/voice/wake/runtime';
const BUNDLE_CEILING_MS = 30_000;

interface BrowserSurface {
  readonly wake: typeof import('../platform/src/platform/voice/wake/runtime.js');
  readonly display: typeof import('../platform/src/platform/utils/batteries/display-payload.js');
  readonly retry: typeof import('../platform/src/platform/types/batteries/retry-wait.js');
  readonly provider: typeof import('../platform/src/platform/routing/batteries/provider.js');
  readonly judgment: typeof import('@goodvibes-jev/judgment/decisions');
  readonly nativeSummary: typeof import('../platform/src/platform/utils/native-error-summary.js');
  readonly nativeErrors: typeof import('../platform/src/platform/types/error-values.js');
}

interface BuildMetafile {
  readonly inputs: Readonly<Record<string, { readonly imports: readonly { readonly path: string; readonly external?: boolean }[] }>>;
}

/** Retain the whole public wake surface and every repaired battery with minimal browser intrinsics. */
async function bundleConsumer(source: boolean): Promise<BrowserSurface> {
  const dir = mkdtempSync(join(tmpdir(), 'gv-wake-browser-'));
  try {
    const scope = join(dir, 'node_modules', '@goodvibes-jev');
    mkdirSync(scope, { recursive: true });
    symlinkSync(ENGINE_ROOT, join(scope, 'engine'), 'dir');
    symlinkSync(JUDGMENT_ROOT, join(scope, 'judgment'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    const entry = join(dir, 'consumer.ts');
    const battery = (path: string) => JSON.stringify(join(ENGINE_ROOT, `platform/${source ? 'src' : 'dist'}/platform/${path}.${source ? 'ts' : 'js'}`));
    writeFileSync(entry, `
      import * as wake from '${PUBLIC_ENTRY}';
      import * as judgment from '@goodvibes-jev/judgment/decisions';
      import * as display from ${battery('utils/batteries/display-payload')};
      import * as retry from ${battery('types/batteries/retry-wait')};
      import * as provider from ${battery('routing/batteries/provider')};
      import * as nativeSummary from ${battery('utils/native-error-summary')};
      import * as nativeErrors from ${battery('types/error-values')};
      globalThis.browserSurface = { wake, judgment, display, retry, provider, nativeSummary, nativeErrors };
    `);
    const output = join(dir, 'consumer.js');
    const metafile = join(dir, 'metafile.json');
    const child = Bun.spawn([
      process.execPath, 'build', entry, '--target=browser', '--format=iife',
      `--outfile=${output}`, `--metafile=${metafile}`, ...(source ? ['--conditions=bun'] : []),
    ], { cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const stdout = new Response(child.stdout).text().catch(() => '');
    const stderr = new Response(child.stderr).text().catch(() => '');
    try {
      const code = await withTestTimeout(child.exited, BUNDLE_CEILING_MS, 'wake runtime browser bundle timed out');
      expect(code, `${await stdout}\n${await stderr}`).toBe(0);
      const graph = JSON.parse(readFileSync(metafile, 'utf8')) as BuildMetafile;
      const paths = Object.keys(graph.inputs).map((path) => path.replaceAll('\\', '/'));
      const tree = source ? 'src' : 'dist';
      const extension = source ? 'ts' : 'js';
      // The package resolver really used the requested condition, and the
      // formerly leaking modules are present rather than optimized away.
      for (const suffix of [
        `platform/${tree}/platform/voice/wake/runtime.${extension}`,
        `platform/${tree}/platform/utils/batteries/display-payload.${extension}`,
        `platform/${tree}/platform/types/batteries/retry-wait.${extension}`,
        `platform/${tree}/platform/routing/batteries/provider.${extension}`,
        `platform/${tree}/platform/utils/native-error-summary.${extension}`,
        `platform/${tree}/platform/types/error-values.${extension}`,
        `judgment/${tree}/decisions.${extension}`,
      ]) expect(paths.some((path) => path.endsWith(suffix)), `missing ${suffix}`).toBe(true);
      // Inspect actual bundle inputs and their edges. Provider runtime modules,
      // host APIs and stores must stay outside the browser bundle.
      const edges = Object.values(graph.inputs).flatMap((input) => input.imports);
      const forbidden = /(?:^|\/)(?:node:|bun:)|sqlite|AsyncLocalStorage|judgment\/(?:src|dist)\/(?:index\.|log\/|port\/(?:client|transport|failover))|platform\/(?:src|dist)\/platform\/logging\//;
      expect([...paths, ...edges.map((edge) => edge.path)].filter((path) => forbidden.test(path))).toEqual([]);
      expect(paths.filter((path) => /platform\/(?:src|dist)\/platform\/providers\//.test(path))).toEqual([]);
      expect(edges.filter((edge) => edge.external)).toEqual([]);
      // Browser cancellation APIs are real intrinsics. This realm has no process,
      // Bun, require, fetch, database or storage globals. The real module
      // initializers and exported functions run here.
      const browserGlobals = Object.assign(Object.create(null), { AbortController, AbortSignal });
      return runInNewContext(`${readFileSync(output, 'utf8')}\nbrowserSurface;`, browserGlobals, {
        timeout: 5_000,
      }) as BrowserSurface;
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      await child.exited.catch(() => undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const source of [true, false]) {
  describe(`wake browser runtime through the ${source ? 'Bun source' : 'published import'} condition`, () => {
    test('executes neutral decisions and the wake error path without a host runtime', async () => {
      const { wake, display, retry, provider, judgment, nativeSummary, nativeErrors } = await bundleConsumer(source);
      expect(judgment.estimateTokens('abcdefg')).toBe(3);
      expect(judgment.LIMITS.maxChoiceOptions).toBe(255);
      expect(judgment.NONE).toBe('none');
      expect(await judgment.mapLimit([3, 1, 2], 2, async (value) => value * 2)).toEqual([6, 2, 4]);
      expect(display.payloadSpans('model [gpt-4o] {"used":29870}').map((span) => span.text))
        .toEqual(['[gpt-4o]', '{"used":29870}']);
      expect(retry.numberSpans('retry after 1.5 seconds').map((span) => span.value)).toEqual([1.5]);
      expect(provider.localServerIdentity.routes).toContain('vllm');
      expect(provider.reasoningFamily.routes).toContain('deepseek-reasoner');
      const nativeFailure = new nativeErrors.AppError('{"message":"Classifier failed"}', 'WAKE_FIXTURE', false,
        { phase: 'inference', requestId: 'synthetic-wake-request', providerCode: 'MODEL_LOAD' });
      expect(nativeSummary.summarizeError(nativeFailure)).toBe('Classifier failed (phase=inference, code=MODEL_LOAD, request_id=synthetic-wake-request)');

      // Sessions are supplied by the host by design. Exercise the real front
      // end and error formatting when one injected classifier rejects, while
      // a second classifier still produces wake detections.
      const warnings: { readonly message: string; readonly meta: Readonly<Record<string, unknown>> | undefined }[] = [];
      const embedding = {
        inputNames: ['input'], outputNames: ['embedding'],
        run: async () => ({ embedding: { data: new Float32Array(wake.WAKE_EMBED_DIM).fill(0.5), dims: [1, 1, 1, wake.WAKE_EMBED_DIM] } }),
      };
      const broken = {
        inputNames: ['input'], outputNames: ['score'],
        run: async () => { throw new Error('corrupt custom model'); },
      };
      const working = {
        inputNames: ['input'], outputNames: ['score'],
        run: async () => ({ score: { data: Float32Array.of(0.99), dims: [1, 1] } }),
      };
      const engine = new wake.WakeWordEngine({
        embedding, models: [{ id: 'broken', session: broken }, { id: 'working', session: working }],
        tuning: { threshold: 0.9, patienceFrames: 1, cooldownMs: 0 },
        now: () => 1_000,
        warn: (message, meta) => warnings.push({ message, meta }),
      });
      const detections: string[] = [];
      for (let frame = 0; frame < wake.WAKE_CLASSIFIER_FRAMES; frame += 1) {
        const result = await engine.pushFrame(new Float32Array(wake.WAKE_CHUNK_SAMPLES));
        detections.push(...result.detections.map((detection) => detection.modelId));
      }
      expect(engine.framesSeen).toBe(wake.WAKE_CLASSIFIER_FRAMES);
      expect(detections).toEqual(['working']);
      expect(warnings).toEqual([{
        message: 'wake model inference failed',
        meta: { modelId: 'broken', error: 'corrupt custom model' },
      }]);
    }, 40_000);
  });
}

import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic } from '@goodvibes-jev/engine/platform/platform/runtime';
import { gateJudgmentRegistry, snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';
import { SOURCE_SCREENING_LIMITS, type ProtectedSourceOwner, type SourceScreeningReceipt } from '@goodvibes-jev/engine/platform/platform/security';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Battery, YesNoItem } from '@goodvibes-jev/judgment';

export interface ProcessClassificationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly sourceOwner?: ProtectedSourceOwner | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

const BATTERY = 'agent.tools.long-lived-process';
const SITE = 'agent.tools.background-process.classification';

/**
 * Read whether a command is an app or server that should outlive its deadline.
 * `undefined` means the reading could not be taken or did not settle; the caller
 * then starts the process and leaves it running past the deadline. Only a
 * cancelled call or a changed caller refuses. The protected receipt stays alive
 * through the last check and the actual spawn.
 */
export async function withLongLivedProcessReading<T>(
  command: string,
  options: ProcessClassificationOptions,
  consume: (longLived: boolean | undefined, assertCurrent: () => void) => T | Promise<T>,
): Promise<T> {
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const state = snapshotJudgmentInput({ command, platform: process.platform }) as { readonly command: string; readonly platform: string };
  const owner = options.sourceOwner;
  const unread = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  if (!owner || typeof state.command !== 'string' || state.command.length > SOURCE_SCREENING_LIMITS.characters) {
    unread(); return await consume(undefined, unread);
  }
  const handle = owner.capture([state.command]);
  let receipt: SourceScreeningReceipt | undefined;
  let released = false;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    released = true; options.signal?.removeEventListener('abort', abort);
    releasing = owner.release(handle); return releasing;
  };
  const abort = () => { void release().catch(() => {}); };
  const assertSourceCurrent = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    if (released) throw new ToolInputProjectionError('held');
    if (receipt) owner.project(receipt);
    options.assertCurrent?.(); options.signal?.throwIfAborted();
  };
  try {
    options.signal?.addEventListener('abort', abort, { once: true });
    assertSourceCurrent();
    const screened = await owner.screen(handle);
    assertSourceCurrent();
    if (screened.status !== 'settled') return await consume(undefined, assertSourceCurrent);
    receipt = screened.receipt;
    const projected = owner.project(receipt);
    if (projected.length !== 1 || typeof projected[0] !== 'string') return await consume(undefined, assertSourceCurrent);
    // Neither a registry lookup nor a port/cache/log/transport is reached until
    // the complete source has a settled, current local screening projection.
    assertSourceCurrent();
    const classification = await decisionOrClassic<{ readonly longLived: boolean | undefined; readonly assertCurrent: () => void }>(async () => {
    const decision = gateJudgmentRegistry.get(BATTERY);
    if (!decision || !('run' in decision) || typeof decision.run !== 'function') return { longLived: undefined, assertCurrent: assertSourceCurrent };
    let port: ReturnType<typeof judgmentPort>;
    try { port = judgmentPort(SITE); }
    catch { return { longLived: undefined, assertCurrent: assertSourceCurrent }; }
    const portModel = port.model, portAsk = port.ask, recorder = port.recorder;
    const assertCurrent = () => {
      assertSourceCurrent();
      if (judgmentPort(SITE) !== port || port.model !== portModel || port.ask !== portAsk
        || port.recorder !== recorder || gateJudgmentRegistry.get(BATTERY) !== decision) throw new ToolInputProjectionError('held');
    };
    const guardedPort: typeof port = { model: portModel, ...(recorder ? { recorder } : {}), ...(port.health ? { health: port.health } : {}), ask: async (request) => {
      assertCurrent();
      const result = await port.ask({ ...request,
        beforeAttempt: () => { assertSynchronousJudgmentGuard(() => request.beforeAttempt?.()); assertCurrent(); },
        assertLogCurrent: () => { assertSynchronousJudgmentGuard(() => request.assertLogCurrent?.(), 'retention'); assertCurrent(); },
      });
      assertCurrent(); return result;
    } };
    assertCurrent();
    let run;
    try {
      run = await (decision as Battery<{ readonly long_lived: YesNoItem }>).run(guardedPort,
        { command: projected[0], platform: state.platform }, { site: SITE, ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
      // A failed reading starts the process anyway; a cancelled call or a changed caller does not.
      if (options.signal?.aborted || error instanceof ToolInputProjectionError) throw error;
      assertCurrent();
      return { longLived: undefined, assertCurrent };
    }
    assertCurrent();
    const reading = run.readings.long_lived;
    if (reading?.kind !== 'yes-no' || reading.outcome !== 'act' || (reading.verdict !== 'yes' && reading.verdict !== 'no')) {
      run.recordAction('process started unclassified: its deadline leaves it running');
      return { longLived: undefined, assertCurrent };
    }
    run.recordAction(reading.verdict === 'yes' ? 'classified long_lived' : 'classified command');
    assertCurrent();
    return { longLived: reading.verdict === 'yes', assertCurrent };
    }, () => ({ longLived: false, assertCurrent: assertSourceCurrent }));
    classification.assertCurrent();
    return await consume(classification.longLived, classification.assertCurrent);
  } finally { await release(); }
}

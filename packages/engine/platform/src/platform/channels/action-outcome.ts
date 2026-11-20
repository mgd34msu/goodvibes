/**
 * What a channel tool or operator action call came to.
 *
 * One value used to mean four things: `null` was "no such surface", "no such
 * tool", "no such action" and "the action ran and found nothing", and a refusal
 * came back as an ordinary object the caller reported as success. The dispatch
 * is total now: every call ends in exactly one of these, and only `ok` is a
 * success.
 */
import { RefusalError, refusal, type Refusal } from '@goodvibes/engine/errors';
import type { ChannelSurface } from './types.js';

export type ChannelActionOutcome =
  | { readonly status: 'ok'; readonly result: unknown }
  /** The call was understood and what it asked about does not exist. */
  | { readonly status: 'not-found'; readonly refusal: Refusal }
  /** The call was understood and refused; `detail` is what the action reported, when it said more. */
  | { readonly status: 'refused'; readonly refusal: Refusal; readonly detail?: unknown }
  /** No such action or tool on this surface; `known` lists the ones there are. */
  | { readonly status: 'unknown-action'; readonly refusal: Refusal; readonly known: readonly string[] };

export function actionOk(result: unknown): ChannelActionOutcome {
  return { status: 'ok', result };
}

export function actionNotFound(what: string, next: readonly string[]): ChannelActionOutcome {
  return {
    status: 'not-found',
    refusal: refusal({ code: 'CHANNEL_NOT_FOUND', state: `${what} does not exist`, reason: `${what} was not found.`, next, status: 404 }),
  };
}

export function actionRefused(
  init: { readonly code?: string; readonly state: string; readonly reason: string; readonly next: readonly string[] },
  detail?: unknown,
): ChannelActionOutcome {
  return {
    status: 'refused',
    refusal: refusal({ code: init.code ?? 'CHANNEL_ACTION_REFUSED', state: init.state, reason: init.reason, next: init.next, status: 400 }),
    ...(detail === undefined ? {} : { detail }),
  };
}

export function unknownChannelAction(
  surface: ChannelSurface,
  kind: 'action' | 'tool' | 'surface',
  id: string,
  known: readonly string[],
): ChannelActionOutcome {
  const listed = known.length > 0 ? known.join(', ') : 'none';
  return {
    status: 'unknown-action',
    known,
    refusal: refusal({
      code: kind === 'surface' ? 'CHANNEL_SURFACE_UNKNOWN' : 'CHANNEL_ACTION_UNKNOWN',
      state: 'nothing was run',
      reason: kind === 'surface'
        ? `No channel plugin is registered for surface '${surface}'.`
        : `The ${surface} surface has no ${kind} '${id}'. Its ${kind}s are: ${listed}.`,
      next: kind === 'surface'
        ? ['List the registered surfaces with the channel status view and use one of them.']
        : [`Call one of: ${listed}.`],
      status: 404,
    }),
  };
}

/**
 * Read a result an action produced into an outcome.
 *
 * Actions answer with their own records; one that says `ok: false` refused
 * (a lifecycle result, a provider operation that lacked an input), and its own
 * words are the reason. Everything else is the answer.
 */
export function outcomeOfActionResult(result: unknown, nextOnRefusal: readonly string[] = []): ChannelActionOutcome {
  if (typeof result === 'object' && result !== null && !Array.isArray(result) && (result as { ok?: unknown }).ok === false) {
    const record = result as { readonly error?: unknown; readonly message?: unknown; readonly refusal?: unknown };
    if (isRefusalShape(record.refusal)) return { status: 'refused', refusal: record.refusal, detail: result };
    const reason = typeof record.error === 'string' && record.error.trim()
      ? record.error.trim()
      : typeof record.message === 'string' && record.message.trim()
        ? record.message.trim()
        : 'The action reported that it did not complete.';
    return actionRefused({ state: 'nothing was changed', reason, next: nextOnRefusal }, result);
  }
  return actionOk(result);
}

/** Run an action body; a thrown refusal becomes a `refused` outcome, any other failure propagates. */
export async function runChannelAction(run: () => Promise<ChannelActionOutcome>): Promise<ChannelActionOutcome> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RefusalError) return { status: 'refused', refusal: error.refusal };
    throw error;
  }
}

/**
 * The value the older `runOperatorAction` / `runTool` signature returns.
 *
 * Kept for callers and third-party plugins written against it: the answer on
 * success, `null` for nothing to run or nothing found, and a refusal as the
 * `{ ok: false, error }` record those callers already read.
 */
export function legacyActionValue(outcome: ChannelActionOutcome, surface: ChannelSurface): unknown {
  switch (outcome.status) {
    case 'ok':
      return outcome.result;
    case 'refused':
      return outcome.detail ?? { surface, ok: false, error: outcome.refusal.reason, refusal: outcome.refusal };
    case 'not-found':
    case 'unknown-action':
      return null;
  }
}

/** A third-party plugin's legacy answer: `null` means it has no such action. */
export function outcomeFromLegacyValue(
  value: unknown,
  surface: ChannelSurface,
  kind: 'action' | 'tool',
  id: string,
  known: readonly string[],
): ChannelActionOutcome {
  if (value === null || value === undefined) return unknownChannelAction(surface, kind, id, known);
  return outcomeOfActionResult(value);
}

/** One line a person or a model can act on: the reason, then the first step. */
export function describeActionFailure(outcome: Exclude<ChannelActionOutcome, { readonly status: 'ok' }>): string {
  const next = outcome.refusal.next[0];
  return next ? `${outcome.refusal.reason} ${next}` : outcome.refusal.reason;
}

function isRefusalShape(value: unknown): value is Refusal {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === 'string' && typeof record.reason === 'string' && typeof record.state === 'string' && Array.isArray(record.next);
}

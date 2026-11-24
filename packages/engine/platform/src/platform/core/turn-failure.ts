/**
 * The one reading of a turn that failed or was refused before it started: what
 * the conversation says about it, in every program that shows it (the
 * terminal's failure row in both terminal programs, the web UI's failed reply).
 *
 * It is worded from facts the failure carried (the provider's HTTP status, a
 * connection errno, how many requests were made, which files the turn changed
 * before it stopped, whether a fallback order is set), never from reading the
 * error's wording, and asks no model. Pure, with no Node imports, so the
 * browser renders the same row from the same facts.
 */

/** Why a turn was refused before any request was made. */
export type TurnRefusalReason =
  /** The selected model's provider is not signed in (no key, no subscription). */
  | 'no-provider'
  /** No model is selected, or the selection names a model no provider serves. */
  | 'no-model'
  /** The Agent sends turns to the GoodVibes service, and it is not running. */
  | 'daemon-unreachable'
  /** The GoodVibes service does not host this folder yet. */
  | 'workspace-not-registered'
  /** The selected model is no longer free, and the person did not keep using it (or chose another model). */
  | 'model-no-longer-free';

/** What the person can do next; each surface puts it on its own key or button. */
export type TurnFailureAction = 'retry' | 'other-model' | 'details' | 'sign-in' | 'choose-model' | 'start-daemon';

export interface TurnFailureReading {
  readonly turnId: string;
  /** "The model didn't answer." */
  readonly headline: string;
  /** "OpenAI returned an error (500) three times." */
  readonly cause: string;
  /**
   * What the turn changed before it stopped, as facts and as the sentence
   * every surface shows. `known` false: nobody recorded it, and `text` is ''
   * (never "Nothing was changed." without the fact). `text` is "Nothing was
   * changed." only when known and nothing was: no file written, no command
   * run, nothing sent, no tool of unknown effect.
   */
  readonly changed: {
    readonly text: string;
    readonly known: boolean;
    /** Files written by tools that name them. */
    readonly files: readonly string[];
    /** Commands run (a command may change files it does not name). */
    readonly commands: number;
    /** Calls that sent something to another service (a message, an MCP call). */
    readonly messages: number;
    /** Successful calls to tools that declare no effects. */
    readonly unknown: number;
  };
  /** The requests made to the provider that failed last, and when each was sent (epoch ms); absent when not counted. */
  readonly attempts?: { readonly count: number; readonly times: readonly number[] } | undefined;
  readonly next: readonly { readonly action: TurnFailureAction; readonly label: string }[];
  /** A second way to the same end, said after the keys: "or run /setup". */
  readonly also?: string | undefined;
  /** Only when a provider failed and no fallback order (provider.fallbackModels) is set. */
  readonly tip?: { readonly text: string; readonly command: string } | undefined;
  /** Everything else, behind "details": provider, model, status, code, the provider's message, attempts, times. */
  readonly details: readonly { readonly label: string; readonly value: string }[];
}

export interface TurnFailureInput {
  readonly turnId: string;
  /** The failure text the turn ended with (`TURN_ERROR.error`), shown only in details. */
  readonly error?: string | undefined;
  readonly stopReason?: string | undefined;
  /** The provider's HTTP status. */
  readonly status?: number | undefined;
  /** A connection errno or machine code (ECONNREFUSED). */
  readonly code?: string | undefined;
  /** Requests made to the provider that failed last, for the request that failed. */
  readonly attempts?: number | undefined;
  /** When each of those requests was sent, epoch ms. */
  readonly attemptTimes?: readonly number[] | undefined;
  /** The provider's display name ("OpenAI"). */
  readonly providerName?: string | undefined;
  /** The provider's id and the model's, for details. */
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  /**
   * What the turn's successful tool calls changed before it stopped, from the
   * turn's own record; undefined says nobody recorded it (no sentence then).
   */
  readonly changes?: TurnChanges | undefined;
  /** Whether provider.fallbackModels names any model. */
  readonly fallbackOrderSet?: boolean | undefined;
  /** Why the fallback order did not move the turn, when it was consulted. */
  readonly fallbackNote?: string | undefined;
  /** Set when the turn was refused before it started. */
  readonly refusal?: TurnRefusalReason | undefined;
  /** The command that starts the GoodVibes service, for `daemon-unreachable`. */
  readonly startCommand?: string | undefined;
}

/** What a turn's successful tool calls changed, as its runner recorded them (TURN_ERROR carries the same fields). */
export interface TurnChanges {
  readonly files: readonly string[];
  readonly commands: number;
  readonly messages: number;
  readonly unknown: number;
}

const HEADLINE_NO_ANSWER = 'The model didn\'t answer.';
const HEADLINE_STOPPED = 'The turn stopped.';
const TIP_TEXT = 'Tip: name a backup model once and GoodVibes switches by itself:';
const TIP_COMMAND = '/model backup';
const PROVIDER_STOPS: ReadonlySet<string> = new Set(['provider_error', 'provider_exhausted']);
const COUNT_WORDS = ['', '', 'twice', 'three times', 'four times', 'five times', 'six times', 'seven times', 'eight times', 'nine times', 'ten times'];

/** " three times" for 3 requests; nothing for one (or an unknown count). */
function times(attempts: number | undefined): string {
  if (attempts === undefined || !Number.isInteger(attempts) || attempts < 2) return '';
  return ` ${COUNT_WORDS[attempts] ?? `${attempts} times`}`;
}

/** The first line of a failure text without its bracket tag ("[Judgment] …"). */
function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? '';
  return line.replace(/^\[[^\]]{1,40}\]\s*/, '');
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

const NOTHING: TurnChanges = { files: [], commands: 0, messages: 0, unknown: 0 };

function count(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function changedReading(input: TurnFailureInput): TurnFailureReading['changed'] {
  // A refused turn ran nothing.
  const changes = input.refusal !== undefined ? NOTHING : input.changes;
  if (!changes) return { text: '', known: false, ...NOTHING };
  const facts = { known: true, files: [...changes.files], commands: changes.commands, messages: changes.messages, unknown: changes.unknown };
  const parts: string[] = [];
  if (changes.files.length > 0) parts.push(`${count(changes.files.length, 'file was', 'files were')} changed`);
  if (changes.commands > 0) parts.push(`${count(changes.commands, 'command', 'commands')} ran`);
  if (changes.messages > 0) parts.push(`${count(changes.messages, 'message was', 'messages were')} sent`);
  if (changes.unknown > 0) parts.push(`${count(changes.unknown, 'tool', 'tools')} of unknown effect ran`);
  if (parts.length === 0) return { text: 'Nothing was changed.', ...facts };
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
  return { text: sentence(`${list.charAt(0).toUpperCase()}${list.slice(1)} before it stopped`), ...facts };
}

function causeOf(input: TurnFailureInput, provider: string): string {
  switch (input.refusal) {
    case 'no-provider':
    case 'no-model': return 'No model is set up yet.';
    case 'daemon-unreachable': return 'The GoodVibes service isn\'t running.';
    case 'workspace-not-registered': return 'The GoodVibes service doesn\'t know this folder yet.';
    case 'model-no-longer-free': return `${input.model ?? 'This model'} is no longer free, so nothing was sent.`;
    case undefined: break;
  }
  const stop = input.stopReason;
  const count = times(input.attempts);
  if (stop === 'provider_exhausted') return `Every backend for this model is out of requests for now${count ? `; asked${count}` : ''}.`;
  if (stop === 'hook_denied') return sentence(`A hook stopped the request: ${firstLine(input.error) || 'it gave no reason'}`);
  if (stop === 'tool_loop_circuit_breaker') return 'It kept repeating the same failing tool calls, so GoodVibes stopped it.';
  const status = input.status;
  if (status === 401 || status === 403) return `${provider} refused the API key (${status})${count}.`;
  if (status === 429) return `${provider} turned the request away for too many requests (429)${count}.`;
  if (status !== undefined) return `${provider} returned an error (${status})${count}.`;
  if (input.code !== undefined) return `GoodVibes couldn't reach ${provider} (${input.code})${count}.`;
  if (stop === undefined || PROVIDER_STOPS.has(stop)) return `${provider} returned an error${count}.`;
  return sentence(firstLine(input.error) || 'It failed without saying why');
}

function clock(ms: number): string {
  const date = new Date(ms);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} UTC`;
}

/** The reading of one failed or refused turn. */
export function readTurnFailure(input: TurnFailureInput): TurnFailureReading {
  const provider = input.providerName?.trim() || input.provider?.trim() || 'The provider';
  const providerFailed = input.refusal === undefined && (input.stopReason === undefined || PROVIDER_STOPS.has(input.stopReason)
    || input.status !== undefined || input.code !== undefined);
  const headline = input.refusal !== undefined || providerFailed ? HEADLINE_NO_ANSWER : HEADLINE_STOPPED;
  const next: { action: TurnFailureAction; label: string }[] = [];
  let also: string | undefined;
  switch (input.refusal) {
    case 'no-provider':
    case 'no-model':
      next.push({ action: 'choose-model', label: 'choose a model' });
      also = 'or run /setup';
      break;
    case 'daemon-unreachable':
      next.push({ action: 'start-daemon', label: input.startCommand ?? 'goodvibes-daemon' });
      next.push({ action: 'retry', label: 'try again' });
      break;
    case 'workspace-not-registered':
      next.push({ action: 'retry', label: 'try again' });
      break;
    case 'model-no-longer-free':
      next.push({ action: 'choose-model', label: 'choose another model' });
      next.push({ action: 'retry', label: 'send it anyway (asks again)' });
      break;
    case undefined:
      if (input.status === 401 || input.status === 403) next.push({ action: 'sign-in', label: 'sign in again' });
      else next.push({ action: 'retry', label: 'try again' });
      if (providerFailed) next.push({ action: 'other-model', label: 'use another model' });
      next.push({ action: 'details', label: 'details' });
      break;
  }
  const details: { label: string; value: string }[] = [];
  const add = (label: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return;
    details.push({ label, value: String(value) });
  };
  add('Provider', input.provider && input.providerName && input.provider !== input.providerName ? `${input.providerName} (${input.provider})` : input.providerName ?? input.provider);
  add('Model', input.model);
  add('Status', input.status);
  add('Code', input.code);
  add('Attempts', input.attempts);
  if (input.attemptTimes && input.attemptTimes.length > 0) add('Times', input.attemptTimes.map(clock).join(', '));
  add('Fallback', input.fallbackNote);
  if (input.changes && input.changes.files.length > 0) add('Changed', input.changes.files.join(', '));
  add('Message', input.error?.trim());
  return {
    turnId: input.turnId,
    headline,
    cause: causeOf(input, provider),
    changed: changedReading(input),
    ...(input.attempts !== undefined && input.attempts > 0 ? { attempts: { count: input.attempts, times: [...(input.attemptTimes ?? [])] } } : {}),
    next,
    ...(also ? { also } : {}),
    ...(providerFailed && input.fallbackOrderSet === false ? { tip: { text: TIP_TEXT, command: TIP_COMMAND } } : {}),
    details,
  };
}

/** The reading as one plain line (headline, cause, what changed), for stores and surfaces that show text only. */
export function turnFailureText(reading: TurnFailureReading): string {
  return [reading.headline, reading.cause, reading.changed.text].filter((part) => part.length > 0).join(' ');
}

/** A stored reading as this build reads it, or undefined when the value is not one. */
export function storedTurnFailure(value: unknown): TurnFailureReading | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const reading = value as Partial<TurnFailureReading>;
  if (typeof reading.headline !== 'string' || typeof reading.cause !== 'string' || !Array.isArray(reading.next) || !Array.isArray(reading.details)) return undefined;
  if (!reading.changed || typeof reading.changed.text !== 'string') return undefined;
  return value as TurnFailureReading;
}

/** Browser-safe native error formatting shared with the server normalizer.
 * Types are erased; no decision port, redaction reader or host policy is loaded.
 */
import { AppError } from '../types/error-values.js';
import type { ErrorNormalizationOptions } from './error-display.js';

const MAX_ERROR_LENGTH = 240;

function truncateMessage(msg: string): string {
  if (msg.length <= MAX_ERROR_LENGTH) return msg;
  return msg.slice(0, MAX_ERROR_LENGTH) + '\u2026';
}

export function extractStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]!;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function extractStructuredMessage(msg: string): string | undefined {
  const trimmed = msg.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    const nestedError = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : undefined;
    const parts = [
      extractStringField(record, 'message'),
      nestedError ? extractStringField(nestedError, 'message') : undefined,
      nestedError ? extractStringField(nestedError, 'code') : undefined,
      nestedError ? extractStringField(nestedError, 'type') : undefined,
      extractStringField(record, 'code'),
      extractStringField(record, 'type'),
    ].filter((value): value is string => Boolean(value));
    return parts.length > 0 ? parts.join(', ') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The message to show. `display` is the message with its machine payload
 * removed by the server's decision-backed reader; without it the
 * message is shown as the error carries it. A message that is all payload
 * falls back to the message itself rather than to nothing.
 */
export function cleanMessage(msg: string, fallbackMessage?: string, display?: string): string {
  const structured = extractStructuredMessage(msg);
  if (structured) return truncateMessage(structured);
  if (display !== undefined && display.length > 0) return truncateMessage(display);
  if (msg.trim().length > 0) return truncateMessage(msg.trim());
  return fallbackMessage ?? 'Unexpected error';
}

export function buildSummary(
  message: string,
  metadata: {
    readonly requestId?: string | undefined;
    readonly providerCode?: string | undefined;
    readonly phase?: string | undefined;
  },
): string {
  const tags: string[] = [];
  if (metadata.phase && !message.toLowerCase().includes(metadata.phase.toLowerCase())) tags.push(`phase=${metadata.phase}`);
  if (metadata.providerCode && !message.includes(metadata.providerCode)) tags.push(`code=${metadata.providerCode}`);
  if (metadata.requestId && !message.includes(metadata.requestId)) tags.push(`request_id=${metadata.requestId}`);
  return tags.length > 0 ? `${message} (${tags.join(', ')})` : message;
}

export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = extractStringField(error as Record<string, unknown>, 'message');
    if (message) return message;
  }
  return String(error);
}

/** Native formatting only: preserve structured messages, bounded text and native error tags. */
export function summarizeError(error: unknown, options: ErrorNormalizationOptions = {}): string {
  const message = cleanMessage(extractErrorMessage(error), options.fallbackMessage);
  return buildSummary(message, {
    requestId: error instanceof AppError ? error.requestId : undefined,
    providerCode: error instanceof AppError ? error.providerCode : undefined,
    phase: error instanceof AppError ? error.phase : undefined,
  });
}

/**
 * agent-occasions-outcome.ts, the argument reading and outcome shaping the
 * `occasions` tool's two halves share.
 *
 * Split out because the tool reached this repo's 800-line file cap, and the cut
 * that keeps the two halves honest is this one: the pieces here are about the
 * TOOL PROTOCOL, what an argument is, what a success looks like, and nothing
 * here knows anything about an occasion. The read handlers
 * (agent-occasions-reads.ts) and the write/capture handlers
 * (agent-occasions-tool.ts) both need them, and a second copy in either would be
 * a second answer to "was this argument given".
 */

import type { OccasionsGatewayInvoke } from './occasions-gateway.js';

export type ToolOutcome = { readonly success: boolean; readonly output: string };

export interface AgentOccasionsToolDeps {
  readonly invoke: OccasionsGatewayInvoke;
}

/** Trimmed, or empty. An absent argument and a whitespace one are the same thing. */
export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A finite number, or nothing. A non-numeric value is absent, never zero. */
export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `self: true` marks the owner's own date; anything but a boolean is refused rather than dropped. */
export function readSelf(value: unknown): { readonly self: boolean } | ToolOutcome {
  if (value === undefined || value === null || value === '') return { self: false };
  if (typeof value !== 'boolean') return fail(['`self` must be true or false. Nothing was recorded.']);
  return { self: value };
}

/**
 * A plan's details, one per entry, trimmed, empty entries left out: the same
 * list the daemon-hosted admission reads from the call, so both sides agree.
 */
export function readDetails(value: unknown): { readonly details: readonly string[] } | ToolOutcome {
  if (value === undefined || value === null) return { details: [] };
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    return fail(['`details` must be a list of strings, one detail each. Nothing was recorded.']);
  }
  return { details: value.flatMap(entry => typeof entry === 'string' && entry.trim() ? [entry.trim()] : []) };
}

export function fail(lines: readonly string[]): ToolOutcome {
  return { success: false, output: lines.filter(Boolean).join('\n') };
}

export function ok(lines: readonly string[]): ToolOutcome {
  return { success: true, output: lines.filter(Boolean).join('\n') };
}

/** Lets a helper return either a parsed value or the refusal to hand straight back. */
export function isOutcome(value: unknown): value is ToolOutcome {
  return typeof value === 'object' && value !== null && 'success' in value && 'output' in value;
}

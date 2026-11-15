import type { TranscriptEventKind } from '@goodvibes-jev/engine/platform/platform/core';

// A record keyed by the union, so adding a kind to `TranscriptEventKind` fails to compile until it is listed here.
const KIND_TABLE: Record<TranscriptEventKind, true> = {
  user_input: true,
  assistant_output: true,
  tool_call: true,
  tool_result: true,
  approval_request: true,
  approval_resolution: true,
  task_transition: true,
  remote_status: true,
  policy_warning: true,
  artifact_preview: true,
  contract_state: true,
  session_restore: true,
  diagnostic_notice: true,
  system_notice: true,
};

export const TRANSCRIPT_EVENT_KINDS: readonly TranscriptEventKind[] = Object.keys(KIND_TABLE) as TranscriptEventKind[];

/** `undefined` means the text names no transcript kind, so the caller can say so instead of showing an unfiltered list. */
export function readTranscriptKind(raw: string | undefined): TranscriptEventKind | 'all' | undefined {
  const normalized = (raw ?? 'all').toLowerCase().replace(/-/g, '_');
  if (normalized === 'all') return 'all';
  return Object.hasOwn(KIND_TABLE, normalized) ? (normalized as TranscriptEventKind) : undefined;
}

/** Message for an unknown kind that names the allowed values. */
export function describeUnknownTranscriptKind(raw: string): string {
  return `Unknown transcript kind "${raw}". Use one of: all, ${TRANSCRIPT_EVENT_KINDS.join(', ')}.`;
}

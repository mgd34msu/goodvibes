import type { RuntimeEventProvenance } from '../../events/occurrence.js';
import type { CheckResult, ContractCommitStatus, ContractEventType } from '../../events/contract.js';
import type { SystemMessagePresentation } from './system-message-presentation.js';

/** The runtime event restated by one of the operator-feed lines. */
export interface RuntimeEventNotice {
  readonly type: string;
  /** Present only when the producer supplied shared occurrence provenance beside the line. */
  readonly key?: string | undefined;
  readonly title: string;
  readonly level: 'info' | 'warning';
  /** The line's detail, without its bracket tag or status mark. */
  readonly detail: string;
}

type NoticeLevel = RuntimeEventNotice['level'];
interface NoticeEntry { readonly title: string; readonly level: NoticeLevel }
const info = (title: string): NoticeEntry => ({ title, level: 'info' });
const warning = (title: string): NoticeEntry => ({ title, level: 'warning' });

/** The event types an operator-feed line can restate. */
export type NoticeEventType = ContractEventType | 'AGENT_COMPLETED' | 'AGENT_FAILED' | 'TURN_CANCEL';

/** How a gate result is told apart: the payload's `skipped` and `passed`. */
type GateVariant = 'passed' | 'skipped' | 'failed';

/** An event with one title, or one per value of the payload field that picks it. */
type NoticeRow = NoticeEntry | { readonly byVariant: Readonly<Record<string, NoticeEntry | null>> } | null;

const CHECK_NOTICES: Readonly<Record<CheckResult, NoticeEntry | null>> = {
  pass: info('Check passed'),
  nudge: warning('Check needs attention'),
  'await-owner': warning('Check needs attention'),
  'native-decision': warning('Check needs attention'),
  stall: warning('Check needs attention'),
  // A turn-end check that only records history gets no line.
  recorded: null,
};

const COMMIT_NOTICES: Readonly<Record<ContractCommitStatus, NoticeEntry>> = {
  committed: info('Changes committed'),
  applied: info('Changes applied'),
  skipped: info('Commit skipped'),
  failed: warning('Commit failed'),
};

const GATE_NOTICES: Readonly<Record<GateVariant, NoticeEntry>> = {
  passed: info('Quality check passed'),
  skipped: info('Quality check skipped'),
  failed: warning('Quality check failed'),
};

/**
 * Title and level of every runtime event a line restates, keyed by the type
 * the producer declares beside the line (and, for three events, the payload
 * field that picks the variant). Typed against the event unions: a new
 * contract event, check result or commit status fails to compile here until
 * it is given a row. `null`: the event has no operator line.
 */
const NOTICES: { readonly [T in NoticeEventType]: NoticeRow } = {
  TURN_CANCEL: info('Response cancelled'),
  AGENT_COMPLETED: info('Agent finished'),
  AGENT_FAILED: warning('Agent failed'),
  CONTRACT_CREATED: info('Workstream started'),
  CONTRACT_STATUS_CHANGED: info('Workstream status changed'),
  CONTRACT_SHAPED: null,
  CONTRACT_PLANNED: null,
  CONTRACT_PLAN_CHECKED: null,
  CONTRACT_GROUP_STATUS_CHANGED: null,
  CONTRACT_UNIT_STATUS_CHANGED: null,
  CONTRACT_UNIT_SPAWNED: null,
  CONTRACT_CHECKED: { byVariant: CHECK_NOTICES },
  CONTRACT_NUDGED: info('Corrections requested'),
  CONTRACT_NUDGE_CONSUMED: null,
  CONTRACT_CRITERION_REGRESSED: warning('Requirement regressed'),
  CONTRACT_STALLED: warning('Workstream stalled'),
  CONTRACT_FIX_PLANNED: null,
  CONTRACT_ESCALATED: warning('Owner decision needed'),
  CONTRACT_OWNER_REPLIED: null,
  CONTRACT_WAITING: warning('Workstream waiting'),
  CONTRACT_GATE_RESULT: { byVariant: GATE_NOTICES },
  CONTRACT_UNIT_SILENT: null,
  CONTRACT_MERGE_CONFLICT: null,
  CONTRACT_ATTEMPTS_SELECTED: null,
  CONTRACT_COMMITTED: { byVariant: COMMIT_NOTICES },
  CONTRACT_PASSED: info('Workstream passed'),
  CONTRACT_FAILED: warning('Workstream failed'),
  CONTRACT_CANCELLED: warning('Workstream cancelled'),
  CONTRACT_SPAWN_GUARD_TRIGGERED: null,
};

function isNoticeEventType(type: string): type is NoticeEventType {
  return Object.hasOwn(NOTICES, type);
}

const fieldOf = (payload: object, key: string): unknown => (Object.hasOwn(payload, key) ? (payload as Record<string, unknown>)[key] : undefined);

/**
 * The variant of a declared event: the stored `variant`, or, on the live
 * payload the producer passes beside the line, the field that picks it.
 * Undefined for an event with one title.
 */
export function runtimeEventVariant(provenance: RuntimeEventProvenance): string | undefined {
  if (typeof provenance.variant === 'string') return provenance.variant;
  switch (provenance.type) {
    case 'CONTRACT_CHECKED': {
      const result = fieldOf(provenance, 'result');
      return typeof result === 'string' ? result : undefined;
    }
    case 'CONTRACT_COMMITTED': {
      const status = fieldOf(provenance, 'status');
      return typeof status === 'string' ? status : undefined;
    }
    case 'CONTRACT_GATE_RESULT': {
      const skipped = fieldOf(provenance, 'skipped'), passed = fieldOf(provenance, 'passed');
      if (typeof skipped !== 'boolean' || typeof passed !== 'boolean') return undefined;
      return skipped ? 'skipped' : passed ? 'passed' : 'failed';
    }
    default:
      return undefined;
  }
}

/** The provenance as it is stored with a line: type, occurrence and variant, nothing of the payload. */
export function storedRuntimeEvent(provenance: RuntimeEventProvenance): RuntimeEventProvenance {
  const variant = runtimeEventVariant(provenance);
  return {
    type: provenance.type,
    ...(provenance.occurrenceId !== undefined ? { occurrenceId: provenance.occurrenceId } : {}),
    ...(variant !== undefined ? { variant } : {}),
  };
}

/** The title and level the producer's declaration gives, or undefined when it names no line. */
function declaredEntry(provenance: RuntimeEventProvenance): NoticeEntry | undefined {
  if (!isNoticeEventType(provenance.type)) return undefined;
  const row = NOTICES[provenance.type];
  if (row === null) return undefined;
  if (!('byVariant' in row)) return row;
  const variant = runtimeEventVariant(provenance);
  if (variant === undefined || !Object.hasOwn(row.byVariant, variant)) return undefined;
  return row.byVariant[variant] ?? undefined;
}

/** The line without its bracket tag or status mark. */
function noticeDetail(text: string): string {
  return text.trim().replace(/^\[[^\]\n]+\]\s*/, '').replace(/^[✓✗]\s*/, '');
}

/** The one title of an event that has no variants. */
function single(type: NoticeEventType): NoticeEntry {
  const row = NOTICES[type];
  if (row === null || 'byVariant' in row) throw new Error(`${type} has no single notice`);
  return row;
}

/**
 * Lines stored before their producer declared the event beside them (older
 * sessions, text-only notices). Matched only for such a line, never to second-
 * guess a declared one.
 */
const LEGACY_NOTICE_LINES: ReadonlyArray<{ readonly pattern: RegExp; readonly type: NoticeEventType; readonly entry: NoticeEntry }> = [
  { pattern: /^\[Response cancelled\]$/, type: 'TURN_CANCEL', entry: single('TURN_CANCEL') },
  { pattern: /^\[Agents\] ✓ \S+ (\S+): ".*" — completed in \d+s \(\d+ tool calls\)$/s, type: 'AGENT_COMPLETED', entry: single('AGENT_COMPLETED') },
  { pattern: /^\[Agents\] ✗ \S+ (\S+): ".*" — failed in \d+s: .*/s, type: 'AGENT_FAILED', entry: single('AGENT_FAILED') },
  { pattern: /^\[Contract\] ✓ (\S+) PASSED: \d+ of \d+ criteria met, \d+ corrections$/, type: 'CONTRACT_PASSED', entry: single('CONTRACT_PASSED') },
  { pattern: /^\[Contract\] ✗ (\S+) FAILED: /s, type: 'CONTRACT_FAILED', entry: single('CONTRACT_FAILED') },
  { pattern: /^\[Contract\] (\S+) cancelled: .* \(\d+ files modified\)$/s, type: 'CONTRACT_CANCELLED', entry: single('CONTRACT_CANCELLED') },
  { pattern: /^\[Contract\] Commit committed for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', entry: COMMIT_NOTICES.committed },
  { pattern: /^\[Contract\] Commit applied for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', entry: COMMIT_NOTICES.applied },
  { pattern: /^\[Contract\] Commit skipped for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', entry: COMMIT_NOTICES.skipped },
  { pattern: /^\[Contract\] Commit failed for (\S+)(?: \(\S+\))?: /s, type: 'CONTRACT_COMMITTED', entry: COMMIT_NOTICES.failed },
  { pattern: /^\[Contract\] \S+ started: /s, type: 'CONTRACT_CREATED', entry: single('CONTRACT_CREATED') },
  { pattern: /^\[Contract\] \S+ \S+ -> \S+$/, type: 'CONTRACT_STATUS_CHANGED', entry: single('CONTRACT_STATUS_CHANGED') },
  { pattern: /^\[Contract\] ✓ Check \S+ of \S+ \S+: \d+\/\d+ criteria met, pass$/, type: 'CONTRACT_CHECKED', entry: CHECK_NOTICES.pass! },
  { pattern: /^\[Contract\] ✗ Check \S+ of \S+ \S+: \d+\/\d+ criteria met, \S+$/, type: 'CONTRACT_CHECKED', entry: CHECK_NOTICES.nudge! },
  { pattern: /^\[Contract\] Nudged unit \S+ \([^\n)]*\)(?: on [^\n]+)?$/, type: 'CONTRACT_NUDGED', entry: single('CONTRACT_NUDGED') },
  { pattern: /^\[Contract\] Criterion \S+ of unit \S+ regressed \(met at \S+\)$/, type: 'CONTRACT_CRITERION_REGRESSED', entry: single('CONTRACT_CRITERION_REGRESSED') },
  { pattern: /^\[Contract\] \S+ \S+ stalled, routed to \S+: /s, type: 'CONTRACT_STALLED', entry: single('CONTRACT_STALLED') },
  { pattern: /^\[Contract\] \S+ needs the owner: /s, type: 'CONTRACT_ESCALATED', entry: single('CONTRACT_ESCALATED') },
  { pattern: /^\[Contract\]\s+✓ Gate: .+ passed$/, type: 'CONTRACT_GATE_RESULT', entry: GATE_NOTICES.passed },
  { pattern: /^\[Contract\]\s+[✓✗] Gate: .+ skipped$/, type: 'CONTRACT_GATE_RESULT', entry: GATE_NOTICES.skipped },
  { pattern: /^\[Contract\]\s+✗ Gate: .+ FAILED$/, type: 'CONTRACT_GATE_RESULT', entry: GATE_NOTICES.failed },
];

/**
 * The runtime event a line restates. A line whose producer declared its event
 * is read from that declaration alone (title and level from the table above,
 * whatever the wording); only a line without one is matched by its text.
 */
export function runtimeEventOfNotice(text: string, runtimeEvent?: RuntimeEventProvenance): RuntimeEventNotice | undefined {
  if (runtimeEvent) {
    const entry = declaredEntry(runtimeEvent);
    if (!entry) return undefined;
    return { type: runtimeEvent.type, title: entry.title, level: entry.level, detail: noticeDetail(text), key: runtimeEventKey(runtimeEvent.type, runtimeEvent) };
  }
  const line = text.trim();
  for (const legacy of LEGACY_NOTICE_LINES) {
    if (!legacy.pattern.test(line)) continue;
    return { type: legacy.type, title: legacy.entry.title, level: legacy.entry.level, detail: noticeDetail(line) };
  }
  return undefined;
}

/**
 * Only producer-declared occurrence provenance can identify duplicate delivery.
 * Older payloads and text-only notices stay keyless. A new wake or imported
 * contract resume mints a new id even when its entity, text and usage repeat.
 */
export function runtimeEventKey(type: string, payload: unknown): string | undefined {
  if (!isNoticeEventType(type) || NOTICES[type] === null) return undefined;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('type' in payload) || payload.type !== type
    || !('occurrenceId' in payload) || typeof payload.occurrenceId !== 'string'
    || payload.occurrenceId.trim().length === 0) return undefined;
  return JSON.stringify([type, payload.occurrenceId]);
}

/** How a line of a declared event is shown: keyed on the declaration, never on the wording. */
export function declaredNoticePresentation(_text: string, provenance?: RuntimeEventProvenance): SystemMessagePresentation | undefined {
  if (!provenance) return undefined;
  const entry = declaredEntry(provenance);
  if (!entry) return undefined;
  const agent = provenance.type === 'AGENT_COMPLETED' || provenance.type === 'AGENT_FAILED';
  return Object.freeze({ activity: agent ? 'agent' : 'system', severity: entry.level,
    event: agent ? 'task_transition' : provenance.type === 'TURN_CANCEL' ? 'system_notice' : 'contract_state' });
}

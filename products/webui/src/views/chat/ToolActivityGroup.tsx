/**
 * A turn's tool calls in the reply that made them (ux A4.5): one collapsed line
 * ("Read 2 files, edited 1 · 4 s", in each tool's own words) that opens to one
 * line per call, said the way the terminal says it (contracts
 * tool-call-summary.ts `summarizeToolCall`, the function the terminal's bead
 * rows read): a status glyph, what the call did ("Reading files"), its key
 * argument ("src/index.ts"), and on the right its one-line result
 * ("2 files · 10 lines") and, when this browser timed it, how long it took.
 *
 * A failed call's line is in --bad with the summary's short failure text. The
 * raw result (JSON, a schema refusal, command output) is never primary text: it
 * is behind the call's own "Details". The calls are there after a reload too:
 * a saved reply keeps its calls and results in its turn history
 * (message-utils.ts toolActivityFromHistory); only the time is not kept.
 */
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { formatBeadTime, summarizeToolCall, type BeadStatus, type ToolCallSummary } from '@goodvibes/engine/contracts';
import { asRecord } from '../../lib/object';
import {
  describeToolActivity,
  toolResultText,
  type CompletedToolCall,
} from './message-utils';
import type { ActiveToolCall } from './useChatStream';

/** Status is never colour alone: each line starts with its glyph. */
const GLYPHS: Readonly<Record<BeadStatus, string>> = {
  ok: '✓', warn: '!', err: '✕', run: '◐', wait: '●', cancel: '○', bg: '▶', unknown: '?',
};

const GLYPH_WORDS: Readonly<Record<BeadStatus, string>> = {
  ok: 'done', warn: 'done, with something to look at', err: 'failed', run: 'running', wait: 'waiting for you', cancel: 'cancelled', bg: 'running in the background', unknown: 'outcome unknown',
};

/** A finished call's one-line summary. */
export function completedCallSummary(call: CompletedToolCall): ToolCallSummary {
  const content = call.result === undefined ? undefined : toolResultText(call.result);
  return summarizeToolCall(
    { id: call.toolCallId, name: call.toolName, arguments: asRecord(call.toolInput), ...(call.activity ? { activity: call.activity } : {}) },
    content,
    { outcome: content === undefined ? undefined : call.isError ? 'error' : 'ok', ownerActive: false },
  );
}

/** A running call's one-line summary. */
export function runningCallSummary(call: ActiveToolCall): ToolCallSummary {
  return summarizeToolCall(
    { id: call.toolCallId, name: call.toolName, arguments: asRecord(call.toolInput), ...(call.activity ? { activity: call.activity } : {}) },
    undefined,
    { outcome: call.cancelled ? 'cancelled' : undefined, ownerActive: !call.cancelled },
  );
}

/** One call as one line: glyph, name, argument, and the result and time on the right (under the line on a phone). */
export function ToolCallLine({ summary, durationMs, raw, trailing }: {
  summary: ToolCallSummary;
  durationMs?: number;
  /** The raw result, behind Details. */
  raw?: string;
  trailing?: ReactNode;
}) {
  const failed = summary.status === 'err';
  const right = [summary.result?.text, durationMs !== undefined ? formatBeadTime(durationMs) : undefined].filter(Boolean).join(' · ');
  return (
    <li className={`tool-line tool-line--${summary.status}${failed ? ' tool-line--failed' : ''}`}>
      <div className="tool-line__row">
        <span className={`tool-line__glyph${summary.status === 'run' ? ' tool-line__glyph--spin' : ''}`} role="img" aria-label={GLYPH_WORDS[summary.status]}>
          {GLYPHS[summary.status]}
        </span>
        <span className="tool-line__name">{summary.name}</span>
        {summary.argument && <span className="tool-line__arg" title={summary.argument}>{summary.argument}</span>}
        {right && <span className={`tool-line__result tool-line__result--${summary.result?.tone ?? 'faint'}`}>{right}</span>}
        {trailing}
      </div>
      {raw && (
        <details className="tool-line__details">
          <summary>Details</summary>
          <pre>{raw}</pre>
        </details>
      )}
    </li>
  );
}

export function ToolActivityGroup({ toolActivity }: { toolActivity: readonly CompletedToolCall[] }) {
  if (toolActivity.length === 0) return null;
  const hasError = toolActivity.some((call) => call.isError);
  return (
    <details className={`message-tool-activity${hasError ? ' message-tool-activity--has-error' : ''}`}>
      <summary className="message-tool-activity__summary">
        <ChevronRight size={14} aria-hidden="true" className="message-tool-activity__chevron" />
        <span className="message-tool-activity__line">{describeToolActivity(toolActivity)}</span>
      </summary>
      <ul className="tool-lines" aria-label="Tool calls">
        {toolActivity.map((call) => {
          const raw = call.result === undefined ? '' : toolResultText(call.result);
          const duration = call.startedAt !== undefined && call.finishedAt !== undefined ? Math.max(0, call.finishedAt - call.startedAt) : undefined;
          return (
            <ToolCallLine
              key={call.toolCallId}
              summary={completedCallSummary(call)}
              {...(duration !== undefined ? { durationMs: duration } : {})}
              {...(raw ? { raw } : {})}
            />
          );
        })}
      </ul>
    </details>
  );
}

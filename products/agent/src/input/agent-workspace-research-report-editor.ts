import { prepareAgentResearchReportInput } from '@goodvibes-jev/engine/terminal-shell/agent-turn/research-report-input';
import type { AgentWorkspaceLocalEditor } from './agent-workspace-types.ts';
import { isAffirmative } from './agent-workspace-command-editor-engine.ts';

type AgentWorkspaceFieldReader = (fieldId: string) => string;

export interface AgentResearchReportWorkspaceToolArgs {
  readonly title: string;
  readonly question: string;
  readonly summary?: string;
  readonly reportMarkdown?: string;
  readonly sources: readonly {
    readonly title: string;
    readonly url?: string;
    readonly urlOmitted?: true;
    readonly credibility?: string;
    readonly note?: string;
  }[];
  readonly findings?: readonly string[];
  readonly gaps?: readonly string[];
  readonly recommendations?: readonly string[];
  readonly methodology?: string;
  readonly confidence?: string;
  readonly requireCitationCoverage?: boolean;
  readonly visualReport?: boolean;
  readonly tags?: readonly string[];
  readonly confirm: true;
  readonly explicitUserRequest: string;
}

function splitList(value: string): readonly string[] {
  return value
    .split(/\n/)
    .map((entry) => entry.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
}

function splitTags(value: string): readonly string[] {
  return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
}

export function createAgentResearchReportEditor(): AgentWorkspaceLocalEditor {
  return {
    kind: 'research-report',
    mode: 'create',
    title: 'Save Research Report',
    selectedFieldIndex: 0,
    message: 'Save a reviewed source-grounded report artifact with citation coverage and a visual report packet. Sources are required; this does not ingest knowledge.',
    fields: [
      { id: 'title', label: 'Title', value: '', required: true, multiline: false, hint: 'Short report title.' },
      { id: 'question', label: 'Question', value: '', required: true, multiline: true, hint: 'The research question this report answers.' },
      { id: 'summary', label: 'Summary', value: '', required: false, multiline: true, hint: 'Optional executive summary.' },
      { id: 'reportMarkdown', label: 'Report markdown', value: '', required: false, multiline: true, hint: 'Full reviewed report body. Use [S1], [S2], etc. for citations when possible.' },
      { id: 'sources', label: 'Sources', value: '', required: true, multiline: true, hint: 'One per line: title | https://source | high/medium/low | note. Credential-redacted, userinfo-bearing or invalid URLs are withheld, not replaced with a different link.' },
      { id: 'findings', label: 'Findings', value: '', required: false, multiline: true, hint: 'Optional one finding per line.' },
      { id: 'gaps', label: 'Gaps', value: '', required: false, multiline: true, hint: 'Optional caveats or unresolved questions, one per line.' },
      { id: 'recommendations', label: 'Recommendations', value: '', required: false, multiline: true, hint: 'Optional next actions, one per line.' },
      { id: 'methodology', label: 'Method', value: '', required: false, multiline: true, hint: 'How sources were found, filtered, and judged.' },
      { id: 'confidence', label: 'Confidence', value: 'medium', required: false, multiline: false, hint: 'Overall confidence such as high, medium, low, or mixed.' },
      { id: 'visualReport', label: 'Visual packet', value: 'yes', required: false, multiline: false, hint: 'Type yes to add at-a-glance, evidence matrix, findings board, dated sources, and handoff checklist sections.' },
      { id: 'requireCitationCoverage', label: 'Require citations', value: '', required: false, multiline: false, hint: 'Type yes to require every listed source to be cited as [S1], [S2], etc. in the report body.' },
      { id: 'tags', label: 'Tags', value: 'research', required: false, multiline: false, hint: 'Comma-separated optional artifact tags.' },
      { id: 'confirm', label: 'Confirm', value: '', required: true, multiline: false, hint: 'Type yes to save this report as an artifact.' },
    ],
  };
}

export function captureAgentResearchReportToolArgs(
  readField: AgentWorkspaceFieldReader,
  explicitUserRequest: string,
): Omit<AgentResearchReportWorkspaceToolArgs, 'sources'> & { readonly sources: string } {
  const summary = readField('summary').trim();
  const reportMarkdown = readField('reportMarkdown').trim();
  const findings = splitList(readField('findings'));
  const gaps = splitList(readField('gaps'));
  const recommendations = splitList(readField('recommendations'));
  const methodology = readField('methodology').trim();
  const confidence = readField('confidence').trim();
  const visualReport = isAffirmative(readField('visualReport'));
  const requireCitationCoverage = isAffirmative(readField('requireCitationCoverage'));
  const tags = splitTags(readField('tags'));
  return {
    title: readField('title').trim(),
    question: readField('question').trim(),
    ...(summary ? { summary } : {}),
    ...(reportMarkdown ? { reportMarkdown } : {}),
    sources: readField('sources'),
    ...(findings.length > 0 ? { findings } : {}),
    ...(gaps.length > 0 ? { gaps } : {}),
    ...(recommendations.length > 0 ? { recommendations } : {}),
    ...(methodology ? { methodology } : {}),
    ...(confidence ? { confidence } : {}),
    ...(visualReport ? { visualReport } : {}),
    ...(requireCitationCoverage ? { requireCitationCoverage } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    confirm: true as const,
    explicitUserRequest,
  };
}

/** Structural preparation is retained for local compatibility helpers only. */
export function buildAgentResearchReportToolArgs(readField: AgentWorkspaceFieldReader, explicitUserRequest: string): AgentResearchReportWorkspaceToolArgs {
  return prepareAgentResearchReportInput(captureAgentResearchReportToolArgs(readField, explicitUserRequest));
}

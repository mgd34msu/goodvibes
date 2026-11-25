/**
 * The acts on research runs, the research queue and sourced reports
 * (capabilities/builtin/research.ts), done by the daemon. The runs and the
 * queue are files of the asking program's project
 * (`.goodvibes/agent/research/`), the reports artifacts in the daemon's store;
 * each change is one call of the Agent tool that makes it in a turn
 * (`agent_research_runs`, `agent_research_sources`, `agent_research_report`),
 * run as the owner's confirmed act. Starting a run hands it to the research
 * runner in the daemon (research-runner.ts), which collects its sources while
 * the answer comes back and goes on whether or not the window that asked is
 * still open; the Work place shows where it stands.
 */
import { CapabilityRefusal, type ActionValues } from '@goodvibes/engine/platform/platform/capabilities';
import { AgentResearchRunRegistry, type AgentResearchRunRecord } from './research-run-registry.js';
import { AgentResearchSourceRegistry, type AgentResearchSourceRecord } from './research-source-registry.js';
import { given, splitWords, storeStep, type StoreAct, type StoreActContext } from './agent-store-common.js';

const lines = (value: string | undefined): readonly string[] => (value ?? '').split('\n').map((line) => line.replace(/^[-*]\s+/, '').trim()).filter(Boolean);

/** A run as facts, for a screen or a script. */
export function researchRunFacts(run: AgentResearchRunRecord) {
  return {
    id: run.id, title: run.title, question: run.question, goal: run.goal, state: run.status, status: run.status, phase: run.phase, progress: run.progress,
    sources: run.sourceIds.length, sourceIds: [...run.sourceIds], nextSteps: [...run.nextSteps], plan: [...run.plan],
    ...(run.note ? { note: run.note } : {}), ...(run.error ? { error: run.error } : {}), ...(run.reportArtifactId ? { report: run.reportArtifactId } : {}),
    updatedAt: run.updatedAt, createdAt: run.createdAt,
  };
}

/** A source in the research queue as facts. */
export function researchSourceFacts(source: AgentResearchSourceRecord) {
  return {
    id: source.id, title: source.title, question: source.question, summary: source.summary, state: source.status, status: source.status,
    credibility: source.credibility, score: source.score, ...(source.url ? { url: source.url } : {}), ...(source.publisher ? { publisher: source.publisher } : {}),
    ...(source.note ? { note: source.note } : {}), updatedAt: source.updatedAt,
  };
}

const runsOf = (context: StoreActContext): AgentResearchRunRegistry => AgentResearchRunRegistry.fromShellPaths(context.shellPaths);
const sourcesOf = (context: StoreActContext): AgentResearchSourceRegistry => AgentResearchSourceRegistry.fromShellPaths(context.shellPaths);

const STATUS_WORDS: Readonly<Record<string, string>> = {
  planned: 'not started', running: 'collecting sources', paused: 'paused', blocked: 'stopped on a problem', completed: 'done', failed: 'failed', cancelled: 'stopped',
};

export const RESEARCH_ACTS: Readonly<Record<string, StoreAct>> = {
  async 'research.runs'(_values, context) {
    const runs = storeStep(() => runsOf(context).list());
    const sources = storeStep(() => sourcesOf(context).list());
    const text = runs.length === 0 && sources.length === 0
      ? 'No research runs and no sources in the research queue for this project.'
      : [
          `Research runs (${runs.length})`,
          ...runs.map((run) => `  ${run.title}: ${STATUS_WORDS[run.status] ?? run.status}, ${run.sourceIds.length} source${run.sourceIds.length === 1 ? '' : 's'}`),
          `Research queue (${sources.length} source${sources.length === 1 ? '' : 's'})`,
          ...sources.slice(0, 20).map((source) => `  ${source.title} (${source.credibility})`),
        ].join('\n');
    return { text, data: { runs: runs.map(researchRunFacts), sources: sources.map(researchSourceFacts) } };
  },
  async 'research.start-run'(values, context) {
    const since = Date.now();
    const plan = lines(values.plan); const next = lines(values.next); const known = splitWords(values.sources);
    await context.tool('agent_research_runs', {
      mode: 'create', title: values.title, question: values.question, ...given(values, 'goal', 'note'),
      ...(plan.length > 0 ? { plan } : {}), ...(next.length > 0 ? { nextSteps: next } : {}), ...(known.length > 0 ? { sourceIds: known } : {}),
      confirm: true, explicitUserRequest: `Start a research run: ${values.title ?? ''}`,
    }, 'keep a research run');
    const run = storeStep(() => runsOf(context).list()).find((record) => record.title === values.title && Date.parse(record.createdAt) >= since - 1000);
    if (!run) {
      throw new CapabilityRefusal(`Research run "${values.title ?? ''}" was kept, but it could not be found again to start it.`, 'Its row in Research, in the Work place, shows it; start a new run if it is not there.');
    }
    if (!context.startResearch) {
      return { text: `Research run "${run.title}" was kept but not started: this daemon has no web search to collect sources with.`, data: { run: researchRunFacts(run) } };
    }
    context.startResearch(run.id, run.title);
    return {
      text: `Research run "${run.title}" started: the daemon is collecting public web sources for it now. Its row in Research shows when it has finished, also after this window closes.`,
      data: { run: researchRunFacts(run) },
    };
  },
  async 'research.add-source'(values, context) {
    const score = values.score?.trim() ? Math.max(0, Math.min(100, Math.round(Number(values.score)))) : undefined;
    await context.tool('agent_research_sources', {
      mode: 'add', question: values.question, title: values.title, summary: values.summary,
      ...given(values, 'url', 'publisher', 'evidence', 'credibility', 'note'), ...(values.published ? { publishedAt: values.published } : {}),
      ...(score === undefined || Number.isNaN(score) ? {} : { score }), tags: values.tags ? splitWords(values.tags) : ['research'],
      confirm: true, explicitUserRequest: `Add a source to the research queue: ${values.title ?? ''}`,
    }, 'add a source to the research queue');
    const kept = storeStep(() => sourcesOf(context).get(values.url?.trim() || values.title || ''));
    return {
      text: `Source "${values.title ?? ''}" kept in your research queue for "${values.question ?? ''}"; it is in Sources, in the Work place.`,
      ...(kept ? { data: { source: researchSourceFacts(kept) } } : {}),
    };
  },
  async 'research.save-report'(values, context) {
    const findings = lines(values.findings); const gaps = lines(values.gaps); const recommendations = lines(values.recommendations);
    await context.tool('agent_research_report', {
      title: values.title, question: values.question, sources: values.sources,
      ...(values.report ? { reportMarkdown: values.report } : {}), ...given(values, 'summary', 'confidence'), ...(values.method ? { methodology: values.method } : {}),
      ...(findings.length > 0 ? { findings } : {}), ...(gaps.length > 0 ? { gaps } : {}), ...(recommendations.length > 0 ? { recommendations } : {}),
      ...(values.visual !== 'no' ? { visualReport: true } : {}), ...(values.cite === 'yes' ? { requireCitationCoverage: true } : {}),
      tags: values.tags ? splitWords(values.tags) : ['research'],
      confirm: true, explicitUserRequest: `Save a sourced report: ${values.title ?? ''}`,
    }, 'save a sourced report');
    return { text: `Report "${values.title ?? ''}" saved as an artifact; it is in Memory and knowledge, Artifacts.` };
  },
};

/** The values a run is started with, for the runner (its id; the request it was asked with, kept with the run). */
export function researchRunnerArgs(runId: string, name: string): ActionValues {
  return { runId, explicitUserRequest: `Start a research run: ${name}` };
}

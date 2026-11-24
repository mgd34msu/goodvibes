/**
 * `/research`, described once (command-actions/): web research. Asking a
 * question or looking at a page goes to the conversation as a message; a
 * research run, a source in the queue and a saved report are each one call of
 * an Agent research tool, run as the owner's own act (owner-tool-call.ts).
 */
import { defineCommand, type ActionDescription, type InputDescription } from '@goodvibes/engine/terminal-shell/command-actions';
import { choiceInput, doAction as doNow, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from './confirmation.ts';
import { given, ownerToolCall, runOwnerToolCall, splitLines, splitWords } from './owner-tool-call.ts';
import { AgentResearchRunRegistry } from '@goodvibes/engine/terminal-shell/agent-turn/research-run-registry';

const LOCAL_ONLY = { terminalOnly: 'Research runs from this Agent\'s conversation and is kept in its home.' } as const;

/** A free-text option: its value is every word up to the next option, so it needs no quotes. */
const words = (flag: `--${string}`) => ({ flag, untilNextFlag: true } as const);

const opt = (id: string, label: string, help: string, flag: `--${string}`, means: string, kind: InputDescription['kind'] = 'text', why = 'your own words'): InputDescription =>
  textInput({ id, label, help, why, kind, typed: words(flag), optional: { default: '', means } });

/** Sends `prompt` to the conversation as the owner's message. */
function ask(ctx: CommandContext, prompt: string): string {
  if (!ctx.submitTurn) throw commandRefusal('Not sent: this surface cannot send a message to the conversation.', 'Type the request in the conversation instead.');
  ctx.submitTurn(prompt);
  return 'Sent to the conversation.';
}

type ResearchAction = ActionDescription<CommandContext>;
/**
 * One Agent research tool call as the owner's act. The tool's own answer (ids, model routes, policy)
 * is for a model; a person reads `said`, one line of what now holds.
 */
function keep(
  tool: string,
  fields: Pick<ResearchAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example'>,
  args: (values: Readonly<Record<string, string>>) => Record<string, unknown>,
  said: (values: Readonly<Record<string, string>>) => string,
): ResearchAction {
  return {
    done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, ownerOnly: ownerToolCall(tool), ...fields,
    async run(values, ctx) {
      await runOwnerToolCall(ctx, tool, { ...args(values), confirm: true, explicitUserRequest: `${fields.label}: ${values.title ?? values.question ?? ''}` }, fields.label.toLowerCase());
      return said(values);
    },
  };
}

/**
 * Starting a run is asked for by its name: the kept run is handed to the research runner (the
 * `research` tool's `runner` action: bounded public web source collection into the run and the
 * source queue) at once. The runner works on while the answer comes back, and says here when it
 * has finished or why it stopped.
 */
function startRun(kept: ResearchAction): ResearchAction {
  return {
    ...kept,
    touches: 'another-machine',
    async run(values, ctx) {
      const since = Date.now();
      // The tool's own answer (its id, routes and policy) is for a model; a person reads one line.
      await kept.run(values, ctx);
      const shellPaths = ctx.workspace?.shellPaths;
      const run = shellPaths
        ? AgentResearchRunRegistry.fromShellPaths(shellPaths).list()
          .find((record) => record.title === values.title && Date.parse(record.createdAt) >= since - 1000)
        : undefined;
      if (!run) return `Research run "${values.title ?? ''}" was kept, but it could not be found to start it; start it again from Research with "Start a research run".`;
      const name = run.title;
      void runOwnerToolCall(ctx, 'research', { action: 'runner', runId: run.id, explicitUserRequest: `Start a research run: ${name}` }, `run the research for "${name}"`)
        .then(
          () => {
            // Said from the run as it now stands, not the runner's own answer (which names model routes).
            const after = shellPaths ? AgentResearchRunRegistry.fromShellPaths(shellPaths).get(run.id) : null;
            const count = after?.sourceIds.length ?? 0;
            ctx.print(`Research run "${name}" finished: ${count} source${count === 1 ? '' : 's'} collected into your research queue. /agent research shows the run and its sources.`);
          },
          (error: unknown) => {
            const why = (error instanceof Error ? error.message : String(error))
              .replace(/^Not done:\s*/, '').replace(/^Admitted research runner blocked for [^:]+:\s*/, '');
            ctx.print(`Research run "${name}" stopped: ${why}`);
          },
        );
      return `Research run "${name}" started. It reports here when it finishes.`;
    },
  };
}

export function registerResearchRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'research',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'Research',
    summary: 'Web research: ask a question, look at a page, keep a research run and its sources, and save a sourced report',
    group: 'Agent',
    actions: [
      doNow<CommandContext>({
        id: 'ask', label: 'Research a question', word: 'ask', touches: 'reads',
        inputs: [
          textInput({ id: 'request', label: 'What to find out', help: 'Ask for the outcome you want, not just keywords', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          opt('hints', 'Sources', 'Such as official docs only, the last 30 days, or primary sources', '--sources', 'current, primary or official sources where there are some'),
        ],
        sentence: 'The question "{request}" goes to the conversation, where the Agent researches it on the web and answers; nothing is added to Agent Knowledge.',
        example: { request: 'Which e-bikes under 2000 have the longest range?' }, operator: LOCAL_ONLY,
        async run(values, ctx) {
          return ask(ctx, [
            `Use connected read-only web tools to research this request: ${values.request}`,
            values.hints ? `Source and freshness guidance: ${values.hints}` : 'Prefer current, primary, or official sources when they are available.',
            'Answer in the main conversation. Do not ingest sources into Agent Knowledge unless I explicitly ask you to.',
          ].join('\n'));
        },
      }),
      doNow<CommandContext>({
        id: 'inspect', label: 'Look at a web page', word: 'inspect', touches: 'reads',
        inputs: [
          textInput({ id: 'url', label: 'Address', help: 'The page\'s web address', why: 'a web address', typed: { position: 1 } }),
          textInput({ id: 'goal', label: 'What you want from it', help: 'What to pull out, compare or check', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: { default: '', means: 'its useful facts, title and caveats' } }),
        ],
        sentence: 'The page at {url} goes to the conversation to be read and summarized; it is not added to Agent Knowledge.',
        example: { url: 'https://example.com/guide' }, operator: LOCAL_ONLY,
        async run(values, ctx) {
          return ask(ctx, [
            `Use connected read-only web tools to inspect this URL: ${values.url}`,
            values.goal ? `Goal: ${values.goal}` : 'Goal: summarize the useful facts, source title, and any caveats.',
            'Do not ingest this into Agent Knowledge unless I explicitly ask you to.',
          ].join('\n'));
        },
      }),
      startRun(keep('agent_research_runs', {
        id: 'start-run', label: 'Start a research run', word: 'start-run',
        inputs: [
          textInput({ id: 'title', label: 'Name', help: 'What the run is called', why: 'a name you choose', typed: words('--title') }),
          textInput({ id: 'question', label: 'Question', help: 'What the run should answer', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          opt('goal', 'Outcome', 'What you want at the end', '--goal', 'the question answered', 'long-text'),
          opt('plan', 'Plan', 'One research step per line', '--plan', 'none yet', 'long-text'),
          opt('next', 'Next steps', 'What to do first, one per line', '--next', 'none yet', 'long-text'),
          opt('sources', 'Known sources', 'Source ids already in your queue, separated by commas', '--sources', 'none', 'text', 'source ids'),
          opt('note', 'Note', 'Context or a caveat', '--note', 'none', 'long-text'),
        ],
        sentence: 'A research run "{title}" for the question "{question}" is kept and started: it collects public web sources into your research queue now, and stays visible and resumable until you change it.',
        example: { title: 'E-bike range', question: 'Which e-bikes have the longest range?' },
      }, (values) => {
        const plan = splitLines(values.plan); const next = splitLines(values.next); const sources = splitWords(values.sources);
        return { mode: 'create', title: values.title, question: values.question, ...given(values, 'goal', 'note'), ...(plan.length > 0 ? { plan } : {}), ...(next.length > 0 ? { nextSteps: next } : {}), ...(sources.length > 0 ? { sourceIds: sources } : {}) };
      }, (values) => `Research run "${values.title ?? ''}" kept.`)),
      keep('agent_research_sources', {
        id: 'add-source', label: 'Add a source to the queue', word: 'add-source',
        inputs: [
          textInput({ id: 'title', label: 'Source', help: 'Its title', why: 'your own words', typed: words('--title') }),
          textInput({ id: 'question', label: 'For the question', help: 'The question or topic it supports', why: 'your own words', typed: words('--question') }),
          textInput({ id: 'summary', label: 'Summary', help: 'What it says, briefly', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          opt('url', 'Address', 'Its web address', '--url', 'none', 'text', 'a web address'),
          opt('publisher', 'Publisher', 'Who published it', '--publisher', 'not given'),
          opt('published', 'Published', 'When it was published', '--published', 'not given', 'text', 'a date'),
          opt('evidence', 'Evidence', 'What in it supports the answer', '--evidence', 'none', 'long-text'),
          choiceInput({
            id: 'credibility', label: 'How far to trust it', help: 'Your judgment of it',
            choices: [{ value: 'unreviewed', label: 'Not judged yet' }, { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }, { value: 'mixed', label: 'Mixed' }],
            typed: { flag: '--credibility' }, optional: { default: 'unreviewed', means: 'not judged yet' },
          }),
          { id: 'score', label: 'Score', help: 'How useful and credible, 0 to 100', kind: 'number', freeTextReason: 'a number from 0 to 100', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--score' } },
          opt('tags', 'Tags', 'Words to find it by, separated by commas', '--tags', 'research'),
          opt('note', 'Note', 'Why it is useful, risky, primary, outdated or disputed', '--note', 'none', 'long-text'),
        ],
        sentence: 'Source "{title}" ("{summary}") is kept in this project\'s research queue for "{question}", until you change it; no report is saved and nothing goes to Agent Knowledge.',
        example: { title: 'Range test 2026', question: 'E-bike range', summary: 'Measured range of twelve bikes.' },
      }, (values) => {
        const score = values.score?.trim() ? Math.max(0, Math.min(100, Math.round(Number(values.score)))) : undefined;
        const tags = values.tags ? splitWords(values.tags) : ['research'];
        return {
          mode: 'add', question: values.question, title: values.title, summary: values.summary,
          ...given(values, 'url', 'publisher', 'evidence', 'credibility', 'note'), ...(values.published ? { publishedAt: values.published } : {}),
          ...(score === undefined || Number.isNaN(score) ? {} : { score }), tags,
        };
      }, (values) => `Source "${values.title ?? ''}" kept in your research queue for "${values.question ?? ''}". /agent research shows the queue.`),
      keep('agent_research_report', {
        id: 'save-report', label: 'Save a sourced report', word: 'save-report',
        inputs: [
          textInput({ id: 'title', label: 'Title', help: 'What the report is called', why: 'your own words', typed: words('--title') }),
          textInput({ id: 'question', label: 'Question', help: 'The question it answers', why: 'your own words', typed: words('--question') }),
          textInput({ id: 'sources', label: 'Sources', help: 'One per line: title | https://address | high/medium/low | note', why: 'your sources', kind: 'long-text', typed: words('--sources') }),
          opt('report', 'Report', 'The reviewed report, citing sources as [S1], [S2]', '--report', 'built from the summary and findings', 'long-text'),
          opt('summary', 'Summary', 'A short summary', '--summary', 'none', 'long-text'),
          opt('findings', 'Findings', 'One per line', '--findings', 'none', 'long-text'),
          opt('gaps', 'Gaps', 'Caveats or open questions, one per line', '--gaps', 'none', 'long-text'),
          opt('recommendations', 'Recommendations', 'Next actions, one per line', '--recommendations', 'none', 'long-text'),
          opt('method', 'Method', 'How the sources were found and judged', '--method', 'not given', 'long-text'),
          choiceInput({
            id: 'confidence', label: 'Confidence', help: 'How sure the report is overall',
            choices: [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }, { value: 'mixed', label: 'Mixed' }],
            typed: { flag: '--confidence' }, optional: { default: 'medium', means: 'medium' },
          }),
          choiceInput({
            id: 'visual', label: 'At-a-glance sections', help: 'An evidence table, findings board, dated sources and handoff checklist',
            choices: [{ value: 'yes', label: 'Add them' }, { value: 'no', label: 'The report only' }],
            typed: { flag: '--plain', switchOn: 'no' }, optional: { default: 'yes', means: 'add them' },
          }),
          choiceInput({
            id: 'cite', label: 'Every source cited', help: 'Refuse to save unless every source is cited as [S1], [S2] in the report',
            choices: [{ value: 'no', label: 'Not required' }, { value: 'yes', label: 'Required' }],
            typed: { flag: '--require-citations', switchOn: 'yes' }, optional: { default: 'no', means: 'not required' },
          }),
          opt('tags', 'Tags', 'Words to find it by, separated by commas', '--tags', 'research'),
        ],
        sentence: 'A report "{title}" answering "{question}" with the sources {sources} is saved as an artifact, until you change it.',
        example: { title: 'E-bike range', question: 'Which e-bikes go furthest?', sources: 'Range test | https://example.com/test | high | measured' },
      }, (values) => {
        const list = (value: string | undefined) => splitLines(value);
        const findings = list(values.findings); const gaps = list(values.gaps); const recommendations = list(values.recommendations);
        return {
          title: values.title, question: values.question, sources: values.sources,
          ...(values.report ? { reportMarkdown: values.report } : {}), ...given(values, 'summary', 'confidence'), ...(values.method ? { methodology: values.method } : {}),
          ...(findings.length > 0 ? { findings } : {}), ...(gaps.length > 0 ? { gaps } : {}), ...(recommendations.length > 0 ? { recommendations } : {}),
          ...(values.visual !== 'no' ? { visualReport: true } : {}), ...(values.cite === 'yes' ? { requireCitationCoverage: true } : {}),
          tags: values.tags ? splitWords(values.tags) : ['research'],
        };
      }, (values) => `Report "${values.title ?? ''}" saved as an artifact. /artifacts list shows it.`),
    ],
  }));
}

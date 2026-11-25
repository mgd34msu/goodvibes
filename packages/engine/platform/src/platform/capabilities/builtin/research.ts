/**
 * Web research (Work and agents). Two homes:
 *
 * - `session`: asking a question or looking at a page is a message to the
 *   conversation of the program holding it (the Agent's), which researches it
 *   on the web and answers there.
 * - `daemon`: research runs, the research queue of sources and sourced reports
 *   are kept in the project (`<project>/.goodvibes/agent/research/`) and the
 *   daemon's artifact store, and the daemon runs a research run's source
 *   collection itself, so a run started from any program goes on after that
 *   program's window closes. The stores' code is the Agent's turn code in
 *   terminal-shell (`agent-turn/agent-store-research.ts`), run by the daemon's
 *   runner over the Agent's stores (agent-stores.ts).
 */
import { CapabilityRefusal, type CapabilityDefinition, type InputDescription } from '../types.js';
import { fixedInput, storeCapability, storeRead, wordsInput } from './agent-stores.js';

/** The conversation a question or a page is sent to, as the owner's own message. */
export interface ResearchConversationServices {
  readonly researchConversation?: { send(prompt: string): void } | undefined;
}

type SessionDefinition = CapabilityDefinition<ResearchConversationServices>;

/** A free-text option typed after its flag, every word up to the next one. */
const words = (flag: `--${string}`) => ({ flag, untilNextFlag: true } as const);
const opt = (id: string, label: string, help: string, flag: `--${string}`, means: string, kind: InputDescription['kind'] = 'text', why = 'your own words'): InputDescription =>
  wordsInput({ id, label, help, why, kind, typed: words(flag), optional: { default: '', means } });

function send(services: ResearchConversationServices, prompt: string): string {
  if (!services.researchConversation) {
    throw new CapabilityRefusal('Nothing was sent: this program has no conversation to research in.', 'Ask it in the GoodVibes Agent\'s conversation.', 'UNAVAILABLE');
  }
  services.researchConversation.send(prompt);
  return 'Sent to the conversation.';
}

export const RESEARCH_ASK: SessionDefinition = {
  capability: { id: 'research.ask', group: 'work', home: 'session', repeat: 'unsafe' },
  actionId: 'ask', label: 'Research a question on the web', word: 'ask',
  inputs: [
    wordsInput({ id: 'request', label: 'What to find out', help: 'Ask for the outcome you want, not just keywords', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
    opt('hints', 'Sources', 'Such as official docs only, the last 30 days, or primary sources', '--sources', 'current, primary or official sources where there are some'),
  ],
  sentence: 'The question "{request}" goes to the conversation, where the Agent researches it on the web and answers; nothing is added to Agent Knowledge.',
  done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { request: 'Which e-bikes under 2000 have the longest range?' },
  available: (services) => services.researchConversation !== undefined,
  async run(values, services) {
    return { text: send(services, [
      `Use connected read-only web tools to research this request: ${values.request}`,
      values.hints ? `Source and freshness guidance: ${values.hints}` : 'Prefer current, primary, or official sources when they are available.',
      'Answer in the main conversation. Do not ingest sources into Agent Knowledge unless I explicitly ask you to.',
    ].join('\n')) };
  },
};

export const RESEARCH_INSPECT: SessionDefinition = {
  capability: { id: 'research.inspect', group: 'work', home: 'session', repeat: 'unsafe' },
  actionId: 'inspect', label: 'Look at a web page and summarize it', word: 'inspect',
  inputs: [
    wordsInput({ id: 'url', label: 'Address', help: 'The page\'s web address', why: 'a web address', typed: { position: 1 } }),
    wordsInput({ id: 'goal', label: 'What you want from it', help: 'What to pull out, compare or check', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: { default: '', means: 'its useful facts, title and caveats' } }),
  ],
  sentence: 'The page at {url} goes to the conversation to be read and summarized; it is not added to Agent Knowledge.',
  done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { url: 'https://example.com/guide' },
  available: (services) => services.researchConversation !== undefined,
  async run(values, services) {
    return { text: send(services, [
      `Use connected read-only web tools to inspect this URL: ${values.url}`,
      values.goal ? `Goal: ${values.goal}` : 'Goal: summarize the useful facts, source title, and any caveats.',
      'Do not ingest this into Agent Knowledge unless I explicitly ask you to.',
    ].join('\n')) };
  },
};

/** The research runs and the queue of sources, for the Work place and a script: rows as facts in `data`. */
export const RESEARCH_RUNS = storeRead({
  id: 'research.runs', group: 'work', actionId: 'runs', label: 'See your research runs and sources', word: 'runs', inputs: [],
  sentence: 'Lists this project\'s research runs, where each stands and the sources it collected, and the research queue of sources.',
  example: {},
});

export const RESEARCH_START_RUN = storeCapability({
  id: 'research.start-run', group: 'work', actionId: 'start-run', label: 'Start a research run', word: 'start-run', touches: 'another-machine',
  inputs: [
    wordsInput({ id: 'title', label: 'Name', help: 'What the run is called', why: 'a name you choose', typed: words('--title') }),
    wordsInput({ id: 'question', label: 'Question', help: 'What the run should answer', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
    opt('goal', 'Outcome', 'What you want at the end', '--goal', 'the question answered', 'long-text'),
    opt('plan', 'Plan', 'One research step per line', '--plan', 'none yet', 'long-text'),
    opt('next', 'Next steps', 'What to do first, one per line', '--next', 'none yet', 'long-text'),
    opt('sources', 'Known sources', 'Source ids already in your queue, separated by commas', '--sources', 'none', 'text', 'source ids'),
    opt('note', 'Note', 'Context or a caveat', '--note', 'none', 'long-text'),
  ],
  sentence: 'A research run "{title}" for the question "{question}" is kept and started: the daemon collects public web sources into your research queue now, and the run stays visible and resumable until you change it.',
  example: { title: 'E-bike range', question: 'Which e-bikes have the longest range?' },
});

export const RESEARCH_ADD_SOURCE = storeCapability({
  id: 'research.add-source', group: 'work', actionId: 'add-source', label: 'Add a source to the research queue', word: 'add-source',
  inputs: [
    wordsInput({ id: 'title', label: 'Source', help: 'Its title', why: 'your own words', typed: words('--title') }),
    wordsInput({ id: 'question', label: 'For the question', help: 'The question or topic it supports', why: 'your own words', typed: words('--question') }),
    wordsInput({ id: 'summary', label: 'Summary', help: 'What it says, briefly', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
    opt('url', 'Address', 'Its web address', '--url', 'none', 'text', 'a web address'),
    opt('publisher', 'Publisher', 'Who published it', '--publisher', 'not given'),
    opt('published', 'Published', 'When it was published', '--published', 'not given', 'text', 'a date'),
    opt('evidence', 'Evidence', 'What in it supports the answer', '--evidence', 'none', 'long-text'),
    fixedInput({
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
});

export const RESEARCH_SAVE_REPORT = storeCapability({
  id: 'research.save-report', group: 'work', actionId: 'save-report', label: 'Save a sourced research report', word: 'save-report',
  inputs: [
    wordsInput({ id: 'title', label: 'Title', help: 'What the report is called', why: 'your own words', typed: words('--title') }),
    wordsInput({ id: 'question', label: 'Question', help: 'The question it answers', why: 'your own words', typed: words('--question') }),
    wordsInput({ id: 'sources', label: 'Sources', help: 'One per line: title | https://address | high/medium/low | note', why: 'your sources', kind: 'long-text', typed: words('--sources') }),
    opt('report', 'Report', 'The reviewed report, citing sources as [S1], [S2]', '--report', 'built from the summary and findings', 'long-text'),
    opt('summary', 'Summary', 'A short summary', '--summary', 'none', 'long-text'),
    opt('findings', 'Findings', 'One per line', '--findings', 'none', 'long-text'),
    opt('gaps', 'Gaps', 'Caveats or open questions, one per line', '--gaps', 'none', 'long-text'),
    opt('recommendations', 'Recommendations', 'Next actions, one per line', '--recommendations', 'none', 'long-text'),
    opt('method', 'Method', 'How the sources were found and judged', '--method', 'not given', 'long-text'),
    fixedInput({
      id: 'confidence', label: 'Confidence', help: 'How sure the report is overall',
      choices: [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }, { value: 'mixed', label: 'Mixed' }],
      typed: { flag: '--confidence' }, optional: { default: 'medium', means: 'medium' },
    }),
    fixedInput({
      id: 'visual', label: 'At-a-glance sections', help: 'An evidence table, findings board, dated sources and handoff checklist',
      choices: [{ value: 'yes', label: 'Add them' }, { value: 'no', label: 'The report only' }],
      typed: { flag: '--plain', switchOn: 'no' }, optional: { default: 'yes', means: 'add them' },
    }),
    fixedInput({
      id: 'cite', label: 'Every source cited', help: 'Refuse to save unless every source is cited as [S1], [S2] in the report',
      choices: [{ value: 'no', label: 'Not required' }, { value: 'yes', label: 'Required' }],
      typed: { flag: '--require-citations', switchOn: 'yes' }, optional: { default: 'no', means: 'not required' },
    }),
    opt('tags', 'Tags', 'Words to find it by, separated by commas', '--tags', 'research'),
  ],
  sentence: 'A report "{title}" answering "{question}" with the sources {sources} is saved as an artifact, until you change it.',
  example: { title: 'E-bike range', question: 'Which e-bikes go furthest?', sources: 'Range test | https://example.com/test | high | measured' },
});

export const RESEARCH_SESSION_CAPABILITIES: readonly SessionDefinition[] = [RESEARCH_ASK, RESEARCH_INSPECT];
export const RESEARCH_DAEMON_CAPABILITIES = [RESEARCH_RUNS, RESEARCH_START_RUN, RESEARCH_ADD_SOURCE, RESEARCH_SAVE_REPORT];

/**
 * System, setup (home `daemon`): what is set up, the checklist topics skipped
 * for now, and whether first run's "Who decides" step was answered or put off,
 * kept once for both terminal programs in the daemon's own folder
 * (`~/.goodvibes/daemon/setup-state.json`). A topic done or skipped in one
 * program is done or skipped in the other, and first run asks once.
 *
 * Carried forward: each program kept its own record at 3.5.0
 * (`~/.goodvibes/<tui|agent>/setup-skipped.json`, `.../who-decides-asked.json`).
 * Each is read into this record once, the first time it is read (nothing
 * dropped); the old files are left as they are, so a 3.5.0 program after a
 * rollback reads its own record as it was at the upgrade.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { resolveGoodVibesDaemonHome } from '../../config/goodvibes-home.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type FixedChoice } from '../types.js';
import type { ProgramSettingsCapabilityServices } from './program-settings.js';
import { noteListChanged } from '../../runtime/list-changes.js';

const PROGRAMS = ['tui', 'agent'] as const;
type Program = typeof PROGRAMS[number];

/** The setup record both programs read. */
export interface SetupState {
  /** The checklist topics skipped for now. */
  readonly skipped: readonly string[];
  /** First run's "Who decides" step: answered or put off, in either program; null while never asked. */
  readonly whoDecides: { readonly how: 'answered' | 'put-off'; readonly at: number } | null;
}

interface SetupStateFile extends SetupState {
  readonly version: 1;
  /** The programs whose own records were read into this one. */
  readonly carried: readonly Program[];
}

/** Where the record is, and where each program kept its own before. */
export function setupStatePaths(homeDirectory: string): { readonly record: string; readonly program: (program: Program, file: string) => string } {
  return {
    record: join(resolveGoodVibesDaemonHome(homeDirectory), 'setup-state.json'),
    program: (program, file) => join(homeDirectory, '.goodvibes', program, file),
  };
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as unknown; } catch { return undefined; }
}

function fileOf(homeDirectory: string): SetupStateFile {
  const raw = readJson(setupStatePaths(homeDirectory).record);
  const record = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const who = record.whoDecides as Record<string, unknown> | null | undefined;
  return {
    version: 1,
    skipped: Array.isArray(record.skipped) ? record.skipped.filter((id): id is string => typeof id === 'string') : [],
    whoDecides: who && (who.how === 'answered' || who.how === 'put-off') && typeof who.at === 'number' ? { how: who.how, at: who.at } : null,
    carried: Array.isArray(record.carried) ? record.carried.filter((program): program is Program => program === 'tui' || program === 'agent') : [],
  };
}

/** The record with each program's own record not carried yet read into it (in memory). */
function carried(homeDirectory: string): SetupStateFile {
  const file = fileOf(homeDirectory);
  const paths = setupStatePaths(homeDirectory);
  let skipped = [...file.skipped];
  let whoDecides = file.whoDecides;
  for (const program of PROGRAMS) {
    if (file.carried.includes(program)) continue;
    const old = readJson(paths.program(program, 'setup-skipped.json'));
    if (Array.isArray(old)) skipped = [...new Set([...skipped, ...old.filter((id): id is string => typeof id === 'string')])];
    const marker = readJson(paths.program(program, 'who-decides-asked.json')) as Record<string, unknown> | undefined;
    if (!whoDecides && marker && marker.version === 1 && typeof marker.checkedAt === 'number') {
      whoDecides = { how: marker.source === 'answered' ? 'answered' : 'put-off', at: marker.checkedAt };
    }
  }
  return { version: 1, skipped, whoDecides, carried: [...PROGRAMS] };
}

/** The setup record as both programs read it (a read never writes: the carry is written with the next change). */
export function readSetupState(homeDirectory: string): SetupState {
  const state = carried(homeDirectory);
  return { skipped: state.skipped, whoDecides: state.whoDecides };
}

/** Change the record (the carry is written with it, once); every screen showing the Setup list reads it again. */
function changeSetupState(homeDirectory: string, change: (state: SetupState) => SetupState): SetupState {
  const next = change(carried(homeDirectory));
  const file: SetupStateFile = { version: 1, skipped: [...new Set(next.skipped)], whoDecides: next.whoDecides, carried: [...PROGRAMS] };
  atomicWriteFileSync(setupStatePaths(homeDirectory).record, `${JSON.stringify(file, null, 2)}\n`, { mkdirp: true });
  noteListChanged({ list: 'setup', change: 'changed' });
  return next;
}

// ---------------------------------------------------------------------------
// The checklist: the topics most people set once, done in either program
// ---------------------------------------------------------------------------

/** The topics most people set once, in order. */
export const SETUP_CHECKLIST_TOPICS = [
  { value: 'model', label: 'Choose a model' },
  // The topics' own labels (system-program.ts SETUP_TOPIC_WORDS).
  { value: 'how-it-works', label: 'When it asks' },
  { value: 'safety', label: 'Safety' },
  { value: 'history', label: 'Saved chats' },
] as const satisfies readonly FixedChoice[];

type Services = ProgramSettingsCapabilityServices & { readonly setupHome?: (() => string) | undefined };
type Def = CapabilityDefinition<Services>;

function homeOf(services: Services): string {
  if (!services.setupHome) throw new CapabilityRefusal('This daemon was started without its home folder; nothing was read or changed.', undefined, 'UNAVAILABLE');
  return services.setupHome();
}

interface ChecklistItem { readonly id: string; readonly label: string; readonly done: boolean; readonly skipped: boolean; readonly note: string }

function checklistOf(services: Services, caller: CapabilityCaller): ChecklistItem[] {
  const state = readSetupState(homeOf(services));
  const configs = PROGRAMS.map((program) => services.programSettings.config({ ...caller, program }));
  const text = (key: string): string => {
    for (const config of configs) { try { const value = String(config.get(key as never) ?? '').trim(); if (value) return value; } catch { /* read the other */ } }
    return '';
  };
  const any = (test: (config: (typeof configs)[number]) => boolean): boolean => configs.some((config) => { try { return test(config); } catch { return false; } });
  const model = text('provider.model');
  const modeChosen = any((config) => config.isExplicitlySet('permissions.mode' as never));
  const sandbox = any((config) => config.get('sandbox.enabled' as never) === true);
  const history = any((config) => config.isExplicitlySet('behavior.saveHistory' as never));
  const items = [
    { id: 'model', done: model.length > 0, note: model || 'no model chosen yet' },
    { id: 'how-it-works', done: modeChosen, note: modeChosen ? 'chosen' : 'when GoodVibes asks: the default, not chosen yet' },
    { id: 'safety', done: sandbox, note: sandbox ? 'sandbox on' : 'sandbox off' },
    { id: 'history', done: history, note: history ? 'chosen' : 'not chosen yet' },
  ];
  return items.map((item) => ({
    ...item, label: SETUP_CHECKLIST_TOPICS.find((topic) => topic.value === item.id)!.label, skipped: !item.done && state.skipped.includes(item.id),
  }));
}

export const SETUP_CHECKLIST: Def = {
  capability: { id: 'setup.checklist', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'checklist', label: 'See what is set up and what is left to set up', word: 'checklist', inputs: [],
  sentence: 'Shows the setup checklist: which of the things most people set once are done in either program, what is left to set up, which are skipped for now, and whether "Who decides" was answered.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const items = checklistOf(services, caller);
    const state = readSetupState(homeOf(services));
    const done = items.filter((item) => item.done).length;
    return {
      text: [
        `${done} of ${items.length} set up.`,
        ...items.map((item) => `${item.done ? '✓' : item.skipped ? '–' : '✕'} ${item.label}: ${item.done ? item.note : item.skipped ? 'skipped for now' : item.note}.`),
        `"Who decides": ${state.whoDecides ? (state.whoDecides.how === 'answered' ? 'answered at first run' : 'put off at first run') : 'not asked yet'}.`,
      ].join('\n'),
      data: { items, whoDecides: state.whoDecides, skipped: state.skipped },
    };
  },
};

export const SETUP_SKIP: Def = {
  capability: { id: 'setup.skip', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'skip', label: 'Skip a topic for now', word: 'skip',
  inputs: [
    { id: 'topic', label: 'Topic', help: 'A topic of the checklist', kind: 'choice', choices: SETUP_CHECKLIST_TOPICS, required: true, typed: { position: 1 } },
    {
      id: 'back', label: 'Skip or bring back', help: 'Skip it for now, or bring a skipped one back', kind: 'choice', typed: { flag: '--back', switchOn: 'yes' },
      choices: [{ value: 'no', label: 'Skip it for now' }, { value: 'yes', label: 'Bring it back' }], required: { default: 'no', defaultMeans: 'skip it for now' },
    },
  ],
  sentence: '{topic} is left off the list of what is left to set up, in both programs; it stays on the Setup list as skipped.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { topic: 'safety' },
  async run(values, services) {
    const topic = SETUP_CHECKLIST_TOPICS.find((entry) => entry.value === values.topic);
    if (!topic) throw new CapabilityRefusal(`${values.topic} is not a topic of the checklist: ${SETUP_CHECKLIST_TOPICS.map((entry) => entry.value).join(', ')}.`);
    const back = values.back === 'yes';
    changeSetupState(homeOf(services), (state) => ({
      ...state, skipped: back ? state.skipped.filter((id) => id !== topic.value) : [...state.skipped, topic.value],
    }));
    return { text: back ? `${topic.label} is back on the checklist.` : `${topic.label} is skipped for now; it stays on the Setup list as skipped.`, data: { topic: topic.value, skipped: !back } };
  },
};

export const SETUP_WHO_DECIDES_ASKED: Def = {
  capability: { id: 'setup.who-decides-asked', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'who-decides-asked', label: 'Record that "Who decides" was asked', word: 'who-decides-asked',
  inputs: [{
    id: 'how', label: 'Answer', help: 'Whether first run\'s "Who decides" step was answered or put off', kind: 'choice', typed: { position: 1 },
    choices: [{ value: 'answered', label: 'Answered' }, { value: 'put-off', label: 'Put off' }], required: true,
  }],
  sentence: 'First run\'s "Who decides" step is recorded as {how}, for both programs, so first run does not open it again by itself.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { how: 'put-off' },
  async run(values, services) {
    if (values.how !== 'answered' && values.how !== 'put-off') throw new CapabilityRefusal(`${values.how} is not answered or put-off.`);
    const how = values.how;
    changeSetupState(homeOf(services), (state) => ({ ...state, whoDecides: { how, at: Date.now() } }));
    return { text: how === 'answered' ? '"Who decides" is recorded as answered.' : '"Who decides" is recorded as put off; the Setup list shows it as not done.' };
  },
};

/** Every capability of this file, with the command it came from. */
export const SYSTEM_SETUP_CAPABILITIES: readonly { readonly definition: Def; readonly command: { readonly name: string; readonly title: string } }[] =
  [SETUP_CHECKLIST, SETUP_SKIP, SETUP_WHO_DECIDES_ASKED].map((definition) => ({ definition, command: { name: 'setup', title: 'Set up GoodVibes' } }));

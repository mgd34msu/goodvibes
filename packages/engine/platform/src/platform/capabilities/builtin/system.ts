/**
 * System: what the daemon holds about this computer and itself, each read or
 * changed through the daemon method that already does it (`caller.method`, the
 * same caller's call, its own admission applying): whether this computer may
 * sleep and the keep-awake switch (`power.*`), the daemon's own updates
 * (`update.status`, `update.check`), the local voice runtime
 * (`voice.local.status`, `voice.local.install`) and the first-run sign-in file
 * (`local_auth.bootstrap.delete`). Each handler only words the method's answer.
 */
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition } from '../types.js';

/** The system capabilities need nothing of their own: every act is a daemon method run as the caller. */
export type SystemCapabilityServices = Readonly<Record<never, never>>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function list(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** Run the daemon method that does this act, as the same caller. */
async function call(caller: CapabilityCaller, methodId: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!caller.method) throw new CapabilityRefusal('This runs in the daemon, and no daemon took the request here; nothing was done.', undefined, 'UNAVAILABLE');
  return record(await caller.method(methodId, body));
}

// ---------------------------------------------------------------------------
// Sleep: power.status.get, power.keepAwake.set
// ---------------------------------------------------------------------------

/** What keep-awake is doing, in words, from the served state. */
export function keepAwakeWords(state: Record<string, unknown>): { readonly state: 'off' | 'held' | 'held-partial' | 'refused'; readonly lines: readonly string[] } {
  const keepAwake = record(state.keepAwake);
  const work = record(state.work);
  const enabled = keepAwake.enabled === true;
  const held = keepAwake.held === true;
  const denied = list(keepAwake.deniedClasses);
  const condition = !enabled ? 'off' : !held ? 'refused' : denied.length > 0 ? 'held-partial' : 'held';
  const reasons = list(work.reasons);
  // The daemon's own words, as a sentence: they arrive starting lower-case and without a full stop.
  const asSentence = (said: string): string => (said ? `${said.charAt(0).toUpperCase()}${said.slice(1)}${/[.!?]$/.test(said) ? '' : '.'}` : '');
  const note = asSentence(text(keepAwake.note));
  const edge = asSentence(text(record(state.sleepEdge).note));
  return {
    state: condition,
    lines: [
      // A refusal is said once: in the daemon's own words when it gave them (verbatim), else in these.
      ...(condition === 'refused' && note ? [] : [condition === 'off' ? 'Keep-awake is off: this computer may sleep when idle.'
        : condition === 'refused' ? 'Keep-awake is on, but the system refused it, so this computer can still sleep.'
          : 'Keep-awake is on: this computer does not sleep when idle.']),
      ...(note ? [note] : []),
      work.held === true
        ? `Work holds it awake now${reasons.length > 0 ? `: ${reasons.join('; ')}` : ''}.`
        : 'No work holds it awake now.',
      ...(edge ? [edge] : []),
    ],
  };
}

export const POWER_STATUS: CapabilityDefinition<SystemCapabilityServices> = {
  capability: { id: 'power.status', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'status', label: 'See whether this machine may sleep', word: 'status', inputs: [],
  sentence: 'Shows whether this computer may sleep, whether keep-awake is on, and what work is keeping the machine awake.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', effects: ['health.read'], example: {},
  async run(_values, _services, caller) {
    const state = await call(caller, 'power.status.get');
    const words = keepAwakeWords(state);
    return { text: words.lines.join('\n'), data: { keepAwake: words.state, state } };
  },
};

function keepAwake(on: boolean): CapabilityDefinition<SystemCapabilityServices> {
  return {
    capability: { id: on ? 'power.on' : 'power.off', group: 'system', home: 'daemon', repeat: 'safe' },
    actionId: on ? 'on' : 'off', label: on ? 'Keep this computer awake' : 'Let this computer sleep again', word: on ? 'on' : 'off', inputs: [],
    sentence: on
      ? 'This computer will not sleep when idle, until you change it; the status bar shows it while it holds.'
      : 'This computer may sleep when idle again, until you change it; work that holds it awake still does.',
    done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', effects: ['config.write'], undoneBy: on ? 'off' : 'on', example: {},
    async run(_values, _services, caller) {
      const state = await call(caller, 'power.keepAwake.set', { enabled: on });
      const words = keepAwakeWords(state);
      return { text: words.lines.join('\n'), data: { keepAwake: words.state } };
    },
  };
}

export const POWER_ON = keepAwake(true);
export const POWER_OFF = keepAwake(false);

// ---------------------------------------------------------------------------
// The daemon's own updates: update.status, update.check
// ---------------------------------------------------------------------------

/** The daemon's update state in sentences: on or off and why, failing checks, a release waiting or installing, a rejected one, a recovery fence. */
export function daemonUpdateWords(status: Record<string, unknown>): readonly string[] {
  const lines: string[] = [];
  const version = text(status.currentVersion);
  lines.push(status.armed === true
    ? `The daemon${version ? ` (${version})` : ''} keeps itself up to date.`
    : `The daemon${version ? ` (${version})` : ''} does not update itself${text(status.offReason) ? `: ${text(status.offReason)}` : ''}.`);
  const failed = typeof status.failedCheckCount === 'number' ? status.failedCheckCount : 0;
  if (failed > 0) lines.push(`${failed} check${failed === 1 ? '' : 's'} in a row failed${text(status.lastCheckFailure) ? `: ${text(status.lastCheckFailure)}` : ''}.`);
  const installing = record(status.installing);
  if (Object.keys(installing).length > 0) lines.push(`It is downloading and installing ${text(installing.version) || text(status.pendingVersion) || 'a newer release'} now.`);
  else if (text(status.pendingVersion)) lines.push(`${text(status.pendingVersion)} was found; it installs when no work is in flight.`);
  if (text(status.rejectedVersion)) lines.push(`${text(status.rejectedVersion)} failed to start and was rolled back; it is not installed again.`);
  if (status.recoveryRequired === true || Object.keys(record(status.transactionRecovery)).length > 0) {
    lines.push('An interrupted update stopped the update loop; it stays off until the kept files are dealt with.');
  }
  return lines;
}

const CHECK_WORDS: Readonly<Record<string, string>> = {
  ran: 'A check ran now.',
  'already-in-flight': 'Another check was already running, so none was started.',
  'loop-off': 'No check ran: the daemon does not update itself.',
  installing: 'A newer release was found; the daemon installs it now and restarts into it.',
};

export const UPDATE_DAEMON: CapabilityDefinition<SystemCapabilityServices> = {
  capability: { id: 'update.daemon', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'daemon', label: 'See the daemon\'s updates', word: 'daemon',
  inputs: [{
    id: 'now', label: 'Check now', help: 'Look for a newer release of the daemon now, or only say what it knows', kind: 'choice',
    choices: [{ value: 'no', label: 'Only say what it knows' }, { value: 'yes', label: 'Check for a newer release now' }],
    required: { default: 'no', defaultMeans: 'only say what it knows' }, typed: { flag: '--check', switchOn: 'yes' },
  }],
  sentence: 'Shows whether the daemon keeps itself up to date, a release it found or is installing, and failing checks; with Check now, it looks for a newer release first.',
  done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none',
  // A check asks the daemon to act (it may install what it finds), which only an administrator may.
  effects: ['control-plane.administer'], example: { now: 'yes' },
  async run(values, _services, caller) {
    const now = values.now === 'yes';
    const status = await call(caller, now ? 'update.check' : 'update.status');
    const check = text(status.check);
    return {
      text: [...(now && CHECK_WORDS[check] ? [CHECK_WORDS[check]!] : []), ...daemonUpdateWords(status)].join('\n'),
      data: { status },
    };
  },
};

// ---------------------------------------------------------------------------
// The local voice runtime: voice.local.status, voice.local.install
// ---------------------------------------------------------------------------

const VOICE_STATE_WORDS: Readonly<Record<string, string>> = {
  'not-provisioned': 'not installed',
  partial: 'partly installed',
  provisioned: 'installed',
  'unsupported-platform': 'not available on this computer',
};

/** The managed voice runtime in sentences: speaking, listening, an install running or its last result. */
export function voiceRuntimeWords(status: Record<string, unknown>): readonly string[] {
  const tts = record(status.tts);
  const stt = record(status.stt);
  const state = text(status.state);
  const lines = [
    `Speaking aloud (${text(tts.engine) || 'piper'}): ${tts.binaryPresent === true && tts.voicePresent === true ? 'installed' : 'not installed'}.`,
    `Listening (${text(stt.engine) || 'whisper.cpp'}): ${VOICE_STATE_WORDS[text(stt.state)] ?? 'not said'}${text(stt.reason) ? ` (${text(stt.reason)})` : ''}.`,
  ];
  if ((state === 'not-provisioned' || state === 'partial') && typeof status.offerBytes === 'number') {
    lines.push(`Installing it downloads about ${megabytes(status.offerBytes)}, each file checked against its pinned checksum; a stopped download goes on from where it stopped.`);
  }
  // An install running (announced when it starts, at each step and when it ends: runtime/voice-setup.ts): each part and its step.
  const running = record(status.installInProgress);
  if (Object.keys(running).length > 0) {
    lines.push('An install is running now:');
    for (const part of Array.isArray(running.components) ? running.components as unknown[] : []) {
      const component = record(part);
      const total = typeof component.bytesTotal === 'number' ? component.bytesTotal : undefined;
      const done = typeof component.bytesDone === 'number' ? component.bytesDone : undefined;
      const size = total !== undefined ? ` (${done !== undefined ? `${megabytes(done)} of ` : ''}${megabytes(total)})` : '';
      lines.push(`  ${text(component.component)}: ${PHASE_WORDS[text(component.phase)] ?? text(component.phase)}${size}${text(component.message) ? `: ${text(component.message)}` : ''}`);
    }
  }
  const last = record(status.lastInstall);
  if (text(last.error)) lines.push(`The last install stopped: ${text(last.error)}. Installing again fetches only what is missing.`);
  else if (Object.keys(record(last.receipt)).length > 0) lines.push(...installReceiptWords(record(last.receipt)));
  return lines;
}

const PHASE_WORDS: Readonly<Record<string, string>> = {
  skip: 'already here', download: 'downloading', verify: 'checking', extract: 'unpacking', done: 'done', error: 'failed',
};

const ENGINE_OUTCOME_WORDS: Readonly<Record<string, string>> = {
  provisioned: 'installed',
  'download-failed': 'the download failed; what was downloaded is kept, and installing again fetches the rest',
  'checksum-mismatch': 'a downloaded file did not match its pinned checksum and was thrown away',
  'unsupported-platform': 'not available on this computer',
};

function megabytes(bytes: number): string {
  return `${Math.max(0.1, Math.round(bytes / 100_000) / 10)} MB`;
}

/** What the last install did: each engine, each part, and the settings it pointed at the runtime or left as you set them. */
function installReceiptWords(receipt: Record<string, unknown>): string[] {
  const proof = record(receipt.proof);
  const engine = (label: string, value: unknown): string => {
    const outcome = record(value);
    const state = text(outcome.state);
    return `  ${label}: ${ENGINE_OUTCOME_WORDS[state] ?? state}${text(outcome.reason) ? ` (${text(outcome.reason)})` : ''}.`;
  };
  const configured = record(receipt.configured);
  const set = Array.isArray(configured.set) ? (configured.set as unknown[]).map(record) : [];
  const skipped = Array.isArray(configured.skipped) ? (configured.skipped as unknown[]).map(record) : [];
  const parts = Array.isArray(receipt.components) ? (receipt.components as unknown[]).map(record) : [];
  return [
    `The last install finished${text(proof.summary) ? `: ${text(proof.summary)}` : receipt.provisioned === true ? ': the voice runtime is installed' : ': the voice runtime is not installed'}.`,
    engine(`Speaking aloud (${text(record(receipt.tts).engine) || 'piper'})`, receipt.tts),
    engine(`Listening (${text(record(receipt.stt).engine) || 'whisper.cpp'})`, receipt.stt),
    ...parts.map((part) => `  ${text(part.id)}: ${text(part.state) === 'skipped' ? 'already here' : text(part.state)}${typeof part.bytes === 'number' ? ` (${megabytes(part.bytes)})` : ''}${text(part.error) ? `: ${text(part.error)}` : ''}`),
    ...(set.length > 0 ? [`  Settings pointed at it: ${set.map((entry) => `${text(entry.key)} = ${String(entry.value)}`).join(', ')}.`] : []),
    ...(skipped.length > 0 ? [`  Settings left as you set them: ${skipped.map((entry) => `${text(entry.key)} (${text(entry.reason)})`).join(', ')}.`] : []),
  ];
}

export const VOICE_STATUS: CapabilityDefinition<SystemCapabilityServices> = {
  capability: { id: 'voice.status', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'status', label: 'See the local voice runtime', word: 'status', inputs: [],
  sentence: 'Shows whether the voice runtime that speaks answers aloud and listens on this computer is installed.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', effects: ['health.read'], example: {},
  async run(_values, _services, caller) {
    const status = await call(caller, 'voice.local.status');
    return { text: voiceRuntimeWords(status).join('\n'), data: { state: text(status.state) || 'not-provisioned', status } };
  },
};

export const VOICE_SETUP: CapabilityDefinition<SystemCapabilityServices> = {
  capability: { id: 'voice.setup', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'setup', label: 'Install the local voice runtime', word: 'setup', inputs: [],
  sentence: 'Downloads and checks the voice runtime that speaks answers aloud and listens on this computer, and points the voice settings at it; a setting you chose yourself is kept.',
  done: '', touches: 'another-machine', lasts: 'not-a-change', risk: 'none', effects: ['config.administer'], example: {},
  async run(_values, _services, caller) {
    const started = await call(caller, 'voice.local.install');
    return {
      text: started.joined === true
        ? 'An install was already running; it goes on in the daemon.'
        : 'The install started; it goes on in the daemon, and the voice runtime says installed once it is done.',
      data: { started },
    };
  },
};

// ---------------------------------------------------------------------------
// The first-run sign-in file: local_auth.bootstrap.delete
// ---------------------------------------------------------------------------

export const LOCAL_AUTH_REMOVE_FIRST_RUN_FILE: CapabilityDefinition<SystemCapabilityServices> = {
  capability: { id: 'local-auth.remove-first-run-file', group: 'system', home: 'daemon', repeat: 'safe' },
  actionId: 'remove-first-run-file', label: 'Remove the first-run sign-in file', word: 'remove-first-run-file', inputs: [],
  sentence: 'The file holding the first-run sign-in is deleted; if no user has been added, nobody can sign in to the web app until one is.',
  done: '', touches: 'credential', lasts: 'kept', risk: 'cannot-be-undone',
  // The method's own: an administrator's act on sign-in, which a model never takes.
  effects: ['auth.administer', 'record.destroy', 'model.refused'], example: {},
  async run(_values, _services, caller) {
    const answer = await call(caller, 'local_auth.bootstrap.delete');
    const removed = answer.removed === true;
    return { text: removed ? 'Removed the first-run sign-in file.' : 'There was no first-run sign-in file.', data: { removed } };
  },
};

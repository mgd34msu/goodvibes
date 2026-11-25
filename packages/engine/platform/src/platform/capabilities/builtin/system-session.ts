/**
 * System, in the program a person is sitting at (home `session`): this
 * session at a glance, closing the program, and how much it prints. They act
 * on the terminal program itself, so each runs there with the program's own
 * services; nothing here reaches a screen.
 */
import type { ShellModeManagerService } from '../../runtime/shell-command-ops.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import { CapabilityRefusal, type CapabilityDefinition, type FixedChoice } from '../types.js';

/** What the program holding the conversation gives the System capabilities that run there. */
export interface SystemSessionServices {
  readonly systemSession?: {
    /** This session at a glance, in the program's own words. */
    status(): string;
    /** Close this program; work the daemon runs goes on. */
    quit(): void;
    /** The program's print level, when it has one. */
    readonly printLevel?: Pick<ShellModeManagerService, 'getHITLMode' | 'getHITLPreset' | 'listHITLPresets' | 'setHITLMode' | 'setDomainVerbosity' | 'getDomainOverrides'> | undefined;
    /** Keep the print level as a setting (`behavior.hitlMode`); throws when it could not be saved. */
    savePrintLevel(level: string): void;
    /** Draw the screen again. */
    redraw(): void;
    /** Speaking answers aloud and listening for the wake word in this program, where it can. */
    readonly speech?: {
      /** Whether every answer is spoken aloud now (`ui.voiceEnabled`). */
      alwaysSpeaks(): boolean;
      /** Speak every answer aloud, or stop; what changed, in words. Throws when no speech output can play here. */
      setAlwaysSpeak(on: boolean): string;
      /** Send a message whose answer is played aloud; absent where nothing can be played. */
      readonly speak?: ((prompt: string) => void) | undefined;
      /** Listen for the wake word again after it stopped; what happened, in words. */
      readonly listenAgain?: (() => Promise<string>) | undefined;
      /** Stop what is being played aloud now; false when nothing was playing. Absent where nothing can be played. */
      readonly stop?: (() => boolean) | undefined;
      /** The wake word on this terminal's microphone: its models and how listening is set, and setting them up. */
      readonly wake?: {
        status(): Promise<string>;
        setup(withSpeechToText: boolean): Promise<string>;
      } | undefined;
    } | undefined;
    /** Whether this program is working (system-program.ts `health.*`), in the program's own words. */
    readonly health?: SystemHealthServices | undefined;
    /** Release readiness of this project, from this session (the terminal app's). */
    readonly release?: {
      review(): string;
      save(path: string, replace: boolean): string;
      read(path: string): string;
    } | undefined;
    /** This program's own start: what its setup has, what is not working, its services, the review as a file, links to its views. */
    readonly startup?: {
      review(): Promise<string>;
      doctor(): Promise<string>;
      services(): Promise<string>;
      save(path: string, replace: boolean): Promise<string>;
      link(view: string, target: string): string;
      openLink(uri: string): string;
    } | undefined;
    /** Every notice and notification this program collected, newest last as the feed keeps them, and their changes. */
    readonly notices?: {
      list(): readonly {
        readonly key: string; readonly domain: string; readonly level: string | undefined; readonly title: string;
        readonly body: string | undefined; readonly timestamp: number; readonly collapsedCount: number;
      }[];
      subscribe(onChange: () => void): () => void;
    } | undefined;
    /** The goodvibes://open link of each of this program's views. */
    readonly viewLinks?: (() => readonly string[]) | undefined;
    /** Every command and key of this program as text, one command's actions, or the keys; opens the palette for a person. */
    readonly help?: ((about: string) => Promise<string>) | undefined;
  } | undefined;
}

/** What `health.*` reads of the program: each part returns the words to show. */
export interface SystemHealthServices {
  report(): Promise<string>;
  check(area: string, provider: string): Promise<string>;
  diagnose(symptom: string): Promise<string>;
  state(domains: readonly string[]): string;
  readonly failures?: {
    show(report: string, view: 'summary' | 'json' | 'bundle'): string;
    save(input: { readonly report: string; readonly path: string; readonly replay: boolean; readonly replace: boolean }): string;
    keep(report: string): Promise<string>;
  } | undefined;
  readonly compat?: ((json: boolean) => Promise<string>) | undefined;
  /** Where the parts this program lacks are, as a name: "the terminal app". */
  readonly elsewhere: string;
}

type System = NonNullable<SystemSessionServices['systemSession']>;

function systemOf(services: SystemSessionServices): System {
  if (!services.systemSession) throw new CapabilityRefusal('This program has nothing of its own to show or change here.', undefined, 'UNAVAILABLE');
  return services.systemSession;
}

function printLevelOf(services: SystemSessionServices): NonNullable<System['printLevel']> {
  const level = systemOf(services).printLevel;
  if (!level) throw new CapabilityRefusal('The print level is not available in this program.', undefined, 'UNAVAILABLE');
  return level;
}

export const SYSTEM_STATUS: CapabilityDefinition<SystemSessionServices> = {
  capability: { id: 'system.status', group: 'system', home: 'session', repeat: 'safe' },
  actionId: 'status', label: 'See this session at a glance', word: '', inputs: [],
  sentence: 'Shows the model in use, its context window and where it came from, and the session\'s other states.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    return { text: systemOf(services).status() };
  },
};

export const SYSTEM_QUIT: CapabilityDefinition<SystemSessionServices> = {
  capability: { id: 'system.quit', group: 'system', home: 'session', repeat: 'safe' },
  actionId: 'quit', label: 'Close this program', word: '', inputs: [],
  sentence: 'This program closes; work the daemon runs goes on without it.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
  ownerOnly: { reason: 'it closes the program you are using', instead: 'Say that the work is done; the owner closes the program.' },
  example: {},
  async run(_values, services) {
    systemOf(services).quit();
    return { text: '' };
  },
};

const LEVELS: readonly FixedChoice[] = [
  { value: 'quiet', label: 'Quiet', help: 'Only warnings and errors pop up; the rest waits in the notifications list.' },
  { value: 'balanced', label: 'Balanced', help: 'Notices pop up; routine notifications wait in the notifications list (the usual).' },
  { value: 'operator', label: 'Operator', help: 'Every notice and notification pops up.' },
];

export const VERBOSITY_SHOW: CapabilityDefinition<SystemSessionServices> = {
  capability: { id: 'verbosity.show', group: 'system', home: 'session', repeat: 'safe' },
  actionId: 'show', label: 'See how much the app prints', word: 'show', inputs: [],
  sentence: 'Shows the print level, what it does, and any kind of notification set on its own.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const level = printLevelOf(services);
    const current = level.getHITLMode();
    const preset = level.getHITLPreset();
    const overrides = Object.entries(level.getDomainOverrides());
    return {
      text: [
        `Print level: ${current}`,
        `  ${preset.description}`,
        `  Default domain verbosity: ${preset.defaultDomainVerbosity}`,
        `  Quiet-while-typing: ${preset.quietWhileTyping}`,
        `  Batch window: ${preset.batchWindowMs}ms`,
        ...(overrides.length > 0 ? ['  Per-domain overrides:', ...overrides.map(([domain, verbosity]) => `    ${domain}: ${verbosity}`)] : ['  No per-domain overrides.']),
        '',
        'Available presets:',
        ...level.listHITLPresets().map((p) => `  ${p.name === current ? '▶' : ' '} ${p.name.padEnd(10)} ${p.description}`),
      ].join('\n'),
      data: { level: current, overrides: Object.fromEntries(overrides) },
    };
  },
};

export const VERBOSITY_SET: CapabilityDefinition<SystemSessionServices> = {
  capability: { id: 'verbosity.set', group: 'system', home: 'session', repeat: 'safe' },
  actionId: 'set', label: 'Set how much the app prints', word: 'set',
  inputs: [{ id: 'level', label: 'Print level', help: 'How much reaches you as it happens', kind: 'choice', required: true, typed: { position: 1 }, choices: LEVELS }],
  sentence: 'The app prints at the {level} level until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { level: 'quiet' },
  async run(values, services) {
    const system = systemOf(services);
    const level = printLevelOf(services);
    const chosen = values.level as 'quiet' | 'balanced' | 'operator';
    if (!LEVELS.some((choice) => choice.value === chosen)) throw new CapabilityRefusal(`${values.level} is not a print level: quiet, balanced or operator.`);
    // Setting the level clears the per-domain levels; the reply names the ones that went.
    const clearedDomains = Object.keys(level.getDomainOverrides());
    level.setHITLMode(chosen);
    let saveFailure: string | null = null;
    try { system.savePrintLevel(chosen); } catch (error) { saveFailure = summarizeError(error); }
    const preset = level.getHITLPreset();
    system.redraw();
    const cleared = clearedDomains.length > 0 ? `\nCleared the per-domain levels for: ${clearedDomains.join(', ')}.` : '';
    return {
      text: saveFailure === null
        ? `Print level set to: ${preset.name}\n${preset.description}${cleared}`
        : `Print level set to: ${preset.name} for this session only. It could not be saved (${saveFailure}), so it reverts on restart.\n${preset.description}${cleared}`,
      data: { level: preset.name, saved: saveFailure === null },
    };
  },
};

export const VERBOSITY_SET_DOMAIN: CapabilityDefinition<SystemSessionServices> = {
  capability: { id: 'verbosity.set-domain', group: 'system', home: 'session', repeat: 'safe' },
  actionId: 'set-domain', label: 'Show fewer or more notifications of one kind', word: 'set-domain',
  inputs: [
    { id: 'domain', label: 'Kind of notification', help: 'A notification domain, as the notifications list shows it', kind: 'text', freeTextReason: 'a domain name from the notifications list', required: true, typed: { position: 1 } },
    { id: 'verbosity', label: 'How much of it', help: 'How much of this kind reaches you', kind: 'choice', required: true, typed: { position: 2 },
      choices: [{ value: 'minimal', label: 'Minimal' }, { value: 'normal', label: 'Normal' }, { value: 'verbose', label: 'Verbose' }] },
  ],
  sentence: 'Notifications of {domain} (agents, tools, providers or another kind) are shown at {verbosity}, fewer or more of them, for this session only.', done: '',
  touches: 'this-machine', lasts: 'session', risk: 'none', example: { domain: 'agents', verbosity: 'minimal' },
  async run(values, services) {
    const verbosity = values.verbosity as 'minimal' | 'normal' | 'verbose';
    if (!['minimal', 'normal', 'verbose'].includes(verbosity)) throw new CapabilityRefusal(`${values.verbosity} is not a level: minimal, normal or verbose.`);
    printLevelOf(services).setDomainVerbosity(values.domain!, verbosity);
    return { text: `Domain "${values.domain}" verbosity set to: ${verbosity}; it applies to notifications of that domain as they arrive.` };
  },
};

// ---------------------------------------------------------------------------
// Speaking and listening: the terminal's own speaker and microphone.
// ---------------------------------------------------------------------------

function speechOf(services: SystemSessionServices): NonNullable<System['speech']> {
  const speech = systemOf(services).speech;
  if (!speech) throw new CapabilityRefusal('Speaking and listening are not available in this program.', undefined, 'UNAVAILABLE');
  return speech;
}

export const VOICE_REVIEW: CapabilityDefinition<SystemSessionServices> = {
  capability: { id: 'voice.review', group: 'system', home: 'session', repeat: 'safe' },
  actionId: 'review', label: 'See your voice settings', word: 'review', inputs: [],
  sentence: 'Shows whether every answer is spoken aloud and how voice is set up here.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const on = speechOf(services).alwaysSpeaks();
    return {
      text: [
        `Every answer spoken aloud: ${on ? 'on' : 'off'}.`,
        'Speaking uses the local voice runtime on this computer; it is optional and off unless you turn it on.',
      ].join('\n'),
      data: { alwaysSpeaks: on },
    };
  },
};

function alwaysSpeak(on: boolean): CapabilityDefinition<SystemSessionServices> {
  return {
    capability: { id: on ? 'voice.on' : 'voice.off', group: 'system', home: 'session', repeat: 'safe' },
    actionId: on ? 'on' : 'off', label: on ? 'Speak every answer aloud' : 'Stop speaking every answer', word: on ? 'on' : 'off', inputs: [],
    sentence: on ? 'Every answer will be played aloud until you change it.' : 'Answers will no longer be played aloud, until you change it.', done: '',
    touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: on ? 'off' : 'on', example: {},
    async run(_values, services) {
      const said = speechOf(services).setAlwaysSpeak(on);
      systemOf(services).redraw();
      return { text: said, data: { alwaysSpeaks: on } };
    },
  };
}

export const VOICE_ON = alwaysSpeak(true);
export const VOICE_OFF = alwaysSpeak(false);

export const VOICE_SPEAK: CapabilityDefinition<SystemSessionServices> = {
  capability: { id: 'voice.speak', group: 'system', home: 'session', repeat: 'unsafe' },
  actionId: 'speak', label: 'Ask and hear the answer spoken', word: 'speak',
  inputs: [{ id: 'prompt', label: 'Message', help: 'What to ask', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } }],
  sentence: '{prompt} is sent as a message and the answer is played aloud.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'none', example: { prompt: 'summarise the last change' },
  async run(values, services) {
    const speech = speechOf(services);
    if (!speech.speak) throw new CapabilityRefusal('Speech output is not available in this session; nothing was sent.', undefined, 'UNAVAILABLE');
    speech.speak(values.prompt!);
    return { text: '' };
  },
};

export const VOICE_WAKE_AGAIN: CapabilityDefinition<SystemSessionServices> = {
  capability: { id: 'voice.wake-again', group: 'system', home: 'session', repeat: 'safe' },
  actionId: 'wake-again', label: 'Listen for the wake word again', word: 'wake-again', inputs: [],
  sentence: 'Listening for the wake word starts again after it stopped by itself (it also starts again when this terminal regains focus).', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const speech = speechOf(services);
    if (!speech.listenAgain) throw new CapabilityRefusal('Wake-word detection is not available in this session.', undefined, 'UNAVAILABLE');
    const said = await speech.listenAgain();
    systemOf(services).redraw();
    return { text: said };
  },
};

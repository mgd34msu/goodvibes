/**
 * `/google`, the entry point for connecting Gmail and Google Calendar.
 *
 * Why this command exists at all: every module of the Google connector was
 * written, unit-tested and shipped with no importer outside its own tests. The
 * flow executor, the console walkthrough, the three credential intake routes,
 * the app-password fast lane and the credential adoption were all reachable
 * only from a test file, so the shipped agent honestly reported that email and
 * calendar were not wired up, they were not. Tests passing said nothing about
 * whether a person could get to the feature.
 *
 * So the surface is deliberately one command rather than subcommands under
 * `/mail` and `/calendar`. One Google account, one OAuth client and one
 * credential serve both mail and calendar; splitting the setup across two
 * commands would have meant two half-flows sharing hidden state, and would
 * have left whichever one the user did not run looking broken.
 *
 * The same reasoning is why this file holds no logic of its own any more. The
 * workspace UI offers these routes as cards, and both surfaces call
 * `google-connection-actions.ts`. This file is the console renderer over those
 * actions: it parses arguments and prints. Anything it decided for itself would
 * be a decision the UI could get differently.
 *
 * Nothing here ever prints a credential.
 */

import type { FeedFetcher } from '@goodvibes/engine/platform/platform/calendar';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { subscriptionRegistryForWrite } from './calendar-subscription-runtime.ts';
import { requireSecretsManager, requireShellPaths } from './runtime-services.ts';
import { routeConfigWrite } from '../../config/daemon-config-routing.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { defineCommand, defineList, type ActionDescription, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { choiceInput, listInput, readAction, textInput } from '@goodvibes/engine/terminal-shell/described-command-kit';
import { renderGoogleSetupReport } from '@goodvibes/engine/platform/platform/google';
import { renderGoogleSetupRunbook } from '@goodvibes/engine/platform/platform/google';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '@goodvibes/engine/platform/platform/google';
import { buildGoodVibesSecretRef } from '../../config/secret-config.ts';
import {
  adoptGoogleCredentials,
  connectGoogle,
  connectGoogleClient,
  describeGoogleConnection,
  forgetGoogleCredentials,
  GOOGLE_CALENDAR_SUBSCRIPTION_NAME,
  googleConfigPort,
  googleSecretPort,
  reauthorizeGoogle,
  runGoogleSetup,
} from './google-connection-actions.ts';
import type { GoogleProgressPort, GoogleSetupPath, GoogleSetupStepSpec, GoogleStepResult } from '@goodvibes/engine/platform/platform/google';
import { getOutwardApprovalStore, listRefusedOutwardActions, takeRefusedOutwardAction, type PendingOutwardAction } from '@goodvibes/engine/terminal-shell/agent-turn/outward-approvals';
import { commandRefusal } from './confirmation.ts';
import { readRefusal } from '@goodvibes/engine/errors';


/** Live progress. A setup run is never a silent grind. */
function progressPort(ctx: CommandContext): GoogleProgressPort {
  return {
    stepStarted: (spec: GoogleSetupStepSpec, index: number, total: number) => {
      ctx.print(`[${index}/${total}] ${spec.title}...`);
    },
    stepFinished: (spec: GoogleSetupStepSpec, result: GoogleStepResult) => {
      ctx.print(`      ${result.outcome}: ${result.detail}`);
    },
    humanActionNeeded: (_spec: GoogleSetupStepSpec, instruction: string) => {
      ctx.print(`      needs you: ${instruction}`);
    },
    note: (message: string) => { ctx.print(`      ${message}`); },
  };
}

/**
 * Where a consent link goes.
 *
 * Printed on its own line with nothing wrapped around it, because the person
 * has to be able to click or copy it cleanly. This is the single action the
 * whole flow asks of anyone.
 */
function consentAnnouncer(ctx: CommandContext): (url: string) => void {
  return (url: string) => {
    ctx.print('');
    ctx.print('Open this link and approve it:');
    ctx.print(url);
    ctx.print('');
  };
}

async function runSetup(path: GoogleSetupPath, ctx: CommandContext): Promise<void> {
  const report = await runGoogleSetup(path, ctx, progressPort(ctx));
  ctx.print(renderGoogleSetupReport(report));
}

async function setAccount(raw: string, ctx: CommandContext): Promise<void> {
  const address = raw.trim();
  if (address.length === 0 || !address.includes('@')) throw commandRefusal(`"${address}" is not an email address; nothing was set.`, 'Line: /google account <your-address@gmail.com>');
  const homeDir = requireShellPaths(ctx).homeDirectory;
  try {
    await routeConfigWrite(ctx.platform.configManager, GOOGLE_CONFIG_KEYS.emailUsername, address, { homeDir });
    await routeConfigWrite(ctx.platform.configManager, GOOGLE_CONFIG_KEYS.emailFromAddress, address, { homeDir });
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`Gmail address not set: ${summarizeError(error)}`);
  }
  ctx.print(`Gmail address set to ${address}. Continue with: /google connect`);
}

/**
 * The private iCal address is a credential in URL form, anyone holding it can
 * read the calendar, so it goes to the encrypted store, not to config.
 *
 * It is also subscribed as a read-only feed, because that registry is what
 * `/calendar refresh` and `/calendar upcoming` read. The new address is
 * fetched before anything is replaced, so an address that does not work
 * leaves the current feed and its stored address as they were.
 */
async function setCalendarAddress(raw: string, ctx: CommandContext, fetcher?: FeedFetcher): Promise<void> {
  const url = raw.trim();
  if (!url.startsWith('https://')) throw commandRefusal('The private calendar address starts with https://; nothing was stored.', 'Copy it from Google Calendar: Settings, your calendar, "Secret address in iCal format".');
  // Touch the secrets manager through the same accessor the ports use, so an
  // unavailable secret store fails here rather than half-way through a write.
  requireSecretsManager(ctx);
  const registry = subscriptionRegistryForWrite(ctx, fetcher);
  if (registry === null) {
    throw commandRefusal('Nothing was stored: no secret manager is available, and the feed address is stored only as a secret.');
  }
  const checked = await registry.validate(url, GOOGLE_CALENDAR_SUBSCRIPTION_NAME);
  if (!checked.ok) {
    throw commandRefusal([`Nothing was stored or replaced: the calendar address could not be read (${checked.stage}); the current calendar feed, if any, is kept.`, `  ${checked.detail}`].join('\n'), undefined, 'COMMAND_FAILED');
  }
  // The address works. A feed under the same name would refuse the subscribe
  // as a duplicate, so the earlier one is dropped now; its address is held so
  // a subscribe that fails after all puts it back.
  const previousUrl = await googleSecretPort(ctx).get(GOOGLE_SECRET_KEYS.calendarIcsUrl).catch(() => null);
  const replaced = await registry.unsubscribeWithReport(GOOGLE_CALENDAR_SUBSCRIPTION_NAME);
  const subscribed = await registry.subscribe(url, GOOGLE_CALENDAR_SUBSCRIPTION_NAME);
  if (!subscribed.ok) {
    if (!replaced.removed) {
      throw commandRefusal([`Nothing was stored: the calendar address could not be subscribed (${subscribed.stage}).`, `  ${subscribed.detail}`].join('\n'), undefined, 'COMMAND_FAILED');
    }
    const restored = typeof previousUrl === 'string' && previousUrl.trim().length > 0
      ? await registry.subscribe(previousUrl, GOOGLE_CALENDAR_SUBSCRIPTION_NAME)
      : null;
    throw commandRefusal([
      restored?.ok
        ? `The new calendar address could not be subscribed (${subscribed.stage}); the previous '${GOOGLE_CALENDAR_SUBSCRIPTION_NAME}' feed was put back.`
        : restored === null
          ? `The new calendar address could not be subscribed (${subscribed.stage}) and the previous '${GOOGLE_CALENDAR_SUBSCRIPTION_NAME}' feed was removed; its address was not stored under the Google setup, so it could not be put back. Run /google calendar-address again.`
          : `The new calendar address could not be subscribed (${subscribed.stage}) and the previous '${GOOGLE_CALENDAR_SUBSCRIPTION_NAME}' feed could not be put back (${restored.ok ? 'unknown' : restored.stage}); its address is still in the secret store. Run /google calendar-address again.`,
      `  ${subscribed.detail}`,
    ].join('\n'));
  }
  // The setup status reads this key to say a calendar address is present.
  await googleSecretPort(ctx).set(GOOGLE_SECRET_KEYS.calendarIcsUrl, url);
  googleConfigPort(ctx).set(GOOGLE_CONFIG_KEYS.calendarIcsUrl, buildGoodVibesSecretRef(GOOGLE_SECRET_KEYS.calendarIcsUrl));
  ctx.print(`Stored the private calendar address in the encrypted secret store and subscribed to it as '${subscribed.name}' (${subscribed.eventCount} events loaded). Update it with: /calendar refresh`);
}

function describePending(entry: PendingOutwardAction): string[] {
  const lines = [`${entry.id}. ${entry.description}`];
  for (const [field, value] of Object.entries(entry.content)) {
    if (value === undefined || value === '') continue;
    const [first = '', ...rest] = value.split('\n');
    lines.push(`   ${field}: ${first}`, ...rest.map((line) => `   ${' '.repeat(field.length)}  ${line}`));
  }
  return lines;
}

/**
 * The waiting sends the last "See sends waiting for your approval" showed, by
 * id with their description. Approving without naming one approves the one
 * that listing showed alone, never a different send that is alone now.
 */
let lastListedSends: ReadonlyMap<number, string> | null = null;

function listWaitingSends(): string {
  const waiting = listRefusedOutwardActions();
  if (waiting.length === 0) {
    lastListedSends = new Map();
    return 'Nothing is waiting for approval. A refused send stays here for five minutes.';
  }
  lastListedSends = new Map(waiting.map((entry) => [entry.id, entry.description] as const));
  return [
    'Refused by the content check, waiting for your approval:',
    ...waiting.flatMap(describePending),
    '',
    waiting.length === 1 ? 'Send it exactly as shown: /google approve   (or drop it: /google drop 1)' : 'Send one exactly as shown: /google approve <n>   (or drop one: /google drop <n>)',
  ].join('\n');
}

/**
 * Approving a refused send reads it, shows it, asks, and sends exactly what
 * was shown: the bytes approved are the bytes sent, nothing waits on the model
 * to repeat its call word for word. Without a number it is bound to the last
 * listing. Owner-only (in the description): a model running the command is
 * exactly the route this exists to defend against.
 */
async function approveRefusedOutwardAction(which: string, ctx: CommandContext): Promise<string> {
  const waiting = listRefusedOutwardActions();
  if (waiting.length === 0) throw commandRefusal('Nothing is waiting for approval; nothing was sent.', 'A refused send stays here for five minutes.');
  let chosen: PendingOutwardAction | undefined;
  if (which) {
    chosen = waiting.find((entry) => String(entry.id) === which.trim());
    if (!chosen) throw commandRefusal(`No waiting send is ${which}; nothing was sent.`, '/google waiting lists them.');
  } else {
    // Bound to the last listing when one showed a single send; with none shown, the one waiting send is shown in the question below.
    const shown = lastListedSends && lastListedSends.size === 1 ? [...lastListedSends][0]! : null;
    if (shown === null && waiting.length !== 1) throw commandRefusal(`Nothing was sent: ${waiting.length} sends are waiting.`, 'See them: /google waiting, then /google approve <n>.');
    chosen = shown === null ? waiting[0] : waiting.find((entry) => entry.id === shown[0]);
    if (!chosen || (shown !== null && waiting.length !== 1)) {
      throw commandRefusal(`Nothing was sent: the waiting sends changed since they were shown (was ${shown?.[0]}: ${shown?.[1]}).`, 'Run /google waiting to see what is waiting, then approve it by its number.', 'TARGET_CHANGED');
    }
  }
  if (!ctx.confirm) throw commandRefusal('A refused send is approved only where you can see it and be asked; nothing was sent.');
  const go = await ctx.confirm({
    title: 'Send this exactly as shown?',
    body: [...describePending(chosen), '', 'It goes outside this machine and cannot be called back.'].join('\n'),
    confirmLabel: 'Send', cancelLabel: 'Back', tone: 'danger',
  });
  if (!go) throw commandRefusal('Not sent; it is still waiting.', undefined, 'CANCELLED');
  const approved = takeRefusedOutwardAction(chosen.id);
  if (!approved) throw commandRefusal('Nothing was sent: that approval expired.', 'Ask for the send again.', 'COMMAND_FAILED');
  if (!approved.perform) {
    // No way to perform it from here: grant a one-use approval for the exact
    // content instead, which the next identical call spends.
    const approval = getOutwardApprovalStore().grant({ action: approved.action, surface: 'owner-direct', content: approved.content });
    if (approval === null) throw commandRefusal(`Could not record the approval for ${approved.description}; nothing was approved.`, 'Ask for the send again.', 'COMMAND_FAILED');
    return `Approved: ${approved.description}. It is tied to that exact content, good once, and expires in five minutes.`;
  }
  const outcome = await approved.perform();
  // The model asked for this; it learns how it ended on its next request.
  ctx.session.conversationManager.hostInstructions.set('replay',
    `The owner approved "${approved.description}" with /google approve. ${outcome.ok ? 'Done' : 'It failed'}: ${outcome.text} Do not send it again.`,
    { once: true, append: true });
  if (!outcome.ok) throw commandRefusal(`Approved, but it did not go through: ${outcome.text}`, undefined, 'COMMAND_FAILED');
  return `Approved and done: ${outcome.text}`;
}

const WAITING_SENDS = defineList<CommandContext>({
  name: 'google.waiting-sends',
  async read() {
    return listRefusedOutwardActions().map((entry): ListRow => ({ value: String(entry.id), label: entry.description }));
  },
  operator: { terminalOnly: 'Refused sends are held by the Agent that refused them.' },
});

/** Every Google action's failure, said as a refusal (a refusal passes through). */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`Google setup could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Google settings are daemon-owned: wait for the connected host's answer and say which it refused (they are put back here). */
async function settled(ctx: CommandContext, text: string | void): Promise<string | void> {
  const refused = await ctx.platform.configManager.settleDaemonWrites();
  if (refused.length === 0) return text;
  return [text, `The connected host refused ${refused.map((entry) => entry.key).join(', ')}; ${refused.length === 1 ? 'it was' : 'they were'} not changed: ${summarizeError(refused[0]!.error)}`].filter(Boolean).join('\n');
}

const CREDENTIAL = 'it stores, adopts, replaces or removes a Google credential';
const AGENT_ONLY = { terminalOnly: 'The Google account is connected from the Agent.' } as const;

/**
 * `/google`, described once (command-actions/): connect Gmail and Google
 * Calendar, see what is connected, store or remove the credentials, and
 * approve a send the content check refused. Nothing prints a credential.
 */
export function createGoogleCommand(fetcher?: FeedFetcher) {
  const actions: ActionDescription<CommandContext>[] = [
    readAction<CommandContext>({
      id: 'status', label: 'See what is connected', word: 'status', operator: AGENT_ONLY,
      sentence: 'Shows what is connected for mail and calendar, proven by reading them.',
      run: (_values, ctx) => guarded(() => describeGoogleConnection(ctx)),
    }),
    {
      id: 'connect', label: 'Connect Gmail and Calendar', word: 'connect', inputs: [],
      sentence: 'Works out the shortest route and connects mail and calendar, asking you at most to approve one consent link; the credential is kept until you change it.',
      done: '', touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'forget', operator: AGENT_ONLY, example: {},
      run: (_values, ctx) => guarded(async () => settled(ctx, (await connectGoogle(ctx, progressPort(ctx), consentAnnouncer(ctx))).text)),
    },
    {
      id: 'reauthorize', label: 'Ask Google for consent again', word: 'reauthorize', inputs: [],
      sentence: 'Asks for a fresh consent covering mail and calendar together, kept until you change it; use it when a scope is missing or the credential is dead.',
      done: '', touches: 'credential', lasts: 'kept', risk: 'none', operator: AGENT_ONLY, example: {},
      run: (_values, ctx) => guarded(async () => settled(ctx, (await reauthorizeGoogle(ctx, progressPort(ctx), consentAnnouncer(ctx))).text)),
    },
    {
      id: 'forget', label: 'Remove the stored Google credentials', word: 'forget', inputs: [],
      sentence: 'Shows which stored Google credentials (refresh token, client secret, app password, private calendar address) would go, asks, and removes exactly those, gone until you change it by connecting again; a value stored since is kept.',
      done: '', touches: 'credential', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: CREDENTIAL, instead: 'Ask the owner to run /google forget.' }, operator: AGENT_ONLY, example: {},
      run: (_values, ctx) => guarded(async () => {
        // Read, show, ask, apply: the yes removes only the values the question named.
        const items = ['refresh-token', 'client-secret', 'app-password', 'calendar-address'] as const;
        const question = await forgetGoogleCredentials(ctx, items, false);
        const body = question.split('\n').filter((line) => !line.startsWith('Confirm with:')).join('\n');
        if (!ctx.confirm) throw commandRefusal('Google credentials are removed only where you can see them and be asked; nothing was removed.');
        if (!(await ctx.confirm({ title: 'Remove these Google credentials?', body: `${body}\n\nThis cannot be undone.`, confirmLabel: 'Remove', cancelLabel: 'Back', tone: 'danger' }))) {
          throw commandRefusal('Not removed; nothing was changed.', undefined, 'CANCELLED');
        }
        return settled(ctx, await forgetGoogleCredentials(ctx, items, true));
      }),
    },
    {
      id: 'adopt', label: 'Take up Google credentials found on this machine', word: 'adopt',
      inputs: [choiceInput({
        id: 'replace', label: 'If some are stored', help: 'Credentials already stored for Google', typed: { flag: '--replace', switchOn: 'yes' },
        choices: [{ value: 'no', label: 'Keep them and stop' }, { value: 'yes', label: 'Replace them', risk: 'cannot-be-undone' }],
        optional: { default: 'no', means: 'keep them and stop' },
      })],
      sentence: 'Google credentials in files on this machine (~/.gmail-mcp) are taken up and stored until you change it.',
      done: '', touches: 'credential', lasts: 'kept', risk: 'none', undoneBy: 'forget',
      ownerOnly: { reason: 'it takes up credential files from the home directory', instead: 'Ask the owner to run /google adopt.' }, operator: AGENT_ONLY, example: { replace: 'yes' },
      run: (values, ctx) => guarded(async () => settled(ctx, (await adoptGoogleCredentials(ctx, { setup: '/google connect', status: '/google status' }, { confirmReplace: values.replace === 'yes' })).text)),
    },
    {
      id: 'setup', label: 'Connect by one chosen route', word: 'setup',
      inputs: [choiceInput({
        id: 'path', label: 'Route', help: 'Which way to connect; "Connect Gmail and Calendar" picks for you', typed: { flag: '--path' },
        choices: [
          { value: 'app-password', label: 'An app password', help: 'Mail only, no Cloud project' },
          { value: 'oauth', label: 'A new OAuth client', help: 'Creates one in a Cloud project' },
          { value: 'existing-client', label: 'An OAuth client you have' },
        ],
        optional: { default: 'app-password', means: 'an app password' },
      })],
      sentence: 'Runs the chosen route step by step, saying each step as it goes; what it stores is kept until you change it.',
      done: '', touches: 'credential', lasts: 'kept', risk: 'none', operator: AGENT_ONLY, example: { path: 'oauth' },
      run: (values, ctx) => guarded(async () => { await runSetup((values.path || 'app-password') as GoogleSetupPath, ctx); return settled(ctx, undefined); }),
    },
    readAction<CommandContext>({
      id: 'runbook', label: 'See the written setup steps', word: 'runbook', operator: AGENT_ONLY,
      sentence: 'Prints the step-by-step instructions for connecting Google by hand.',
      run: async () => renderGoogleSetupRunbook(),
    }),
    {
      id: 'client-file', label: 'Use an OAuth client file you have', word: 'client-file',
      inputs: [textInput({ id: 'path', label: 'Client file', help: 'The client JSON downloaded from the Google console', why: 'a file path', kind: 'path', typed: { position: 1 } })],
      sentence: 'The client in {path} is stored and a consent link is asked for; it is kept until you change it.',
      done: '', touches: 'credential', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: 'it stores the client secret from a file', instead: 'Ask the owner to run /google client-file.' }, operator: AGENT_ONLY, example: { path: 'client_secret.json' },
      run: (values, ctx) => guarded(async () => settled(ctx, (await connectGoogleClient(ctx, { kind: 'client-json-file', path: values.path!.trim() }, progressPort(ctx), consentAnnouncer(ctx))).text)),
    },
    {
      id: 'client', label: 'Use an OAuth client id and secret', word: 'client',
      inputs: [
        textInput({ id: 'clientId', label: 'Client id', help: 'Copied from the Google console', why: 'an id Google gave you', typed: { position: 1 } }),
        { id: 'clientSecret', label: 'Client secret', help: 'Copied from the Google console; hidden as you type', kind: 'secret', required: true, typed: { position: 2 } },
      ],
      sentence: 'Client {clientId} and its secret are stored and a consent link is asked for; no Cloud project step is run, and it is kept until you change it.',
      done: '', touches: 'credential', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: 'it stores a client secret', instead: 'Ask the owner to run /google client.' }, operator: AGENT_ONLY, example: { clientId: '1234.apps.googleusercontent.com' },
      run: (values, ctx) => guarded(async () => settled(ctx, (await connectGoogleClient(ctx, { kind: 'manual-entry', clientId: values.clientId!.trim(), clientSecret: values.clientSecret!.trim() }, progressPort(ctx), consentAnnouncer(ctx))).text)),
    },
    {
      id: 'account', label: 'Set the Gmail address', word: 'account',
      inputs: [textInput({ id: 'address', label: 'Address', help: 'The Gmail address to connect and send as', why: 'your own address', typed: { position: 1 } })],
      sentence: 'Mail is signed in and sent as {address} until you change it.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: 'it changes the address mail is sent and signed in as', instead: 'Ask the owner to run /google account.' }, operator: AGENT_ONLY, example: { address: 'you@gmail.com' },
      run: (values, ctx) => guarded(async () => { await setAccount(values.address!, ctx); return settled(ctx, undefined); }),
    },
    {
      id: 'calendar-address', label: 'Read the calendar by its private address', word: 'calendar-address',
      inputs: [{ id: 'url', label: 'Private address', help: 'The calendar\'s "Secret address in iCal format"; hidden as you type', kind: 'secret', required: true, typed: { position: 1 } }],
      sentence: 'The private address is stored in the secret store and subscribed as the Google calendar feed, replacing the current one, until you change it.',
      done: '', touches: 'credential', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: 'it stores a private calendar address (a credential) and replaces the current feed', instead: 'Ask the owner to run /google calendar-address.' }, operator: AGENT_ONLY, example: {},
      run: (values, ctx) => guarded(async () => { await setCalendarAddress(values.url!, ctx, fetcher); return settled(ctx, undefined); }),
    },
    readAction<CommandContext>({
      id: 'waiting', label: 'See sends waiting for your approval', word: 'waiting', operator: AGENT_ONLY,
      sentence: 'Shows each send the content check refused, exactly as it would go out.',
      run: async () => listWaitingSends(),
    }),
    {
      id: 'approve', label: 'Send a refused send as shown', word: 'approve',
      inputs: [listInput({ id: 'send', label: 'Send', help: 'The sends waiting for approval', list: WAITING_SENDS, other: 'a number /google waiting showed', optional: { default: '', means: 'the one the last list showed' } })],
      sentence: 'The refused send is shown once more and, when you say so, goes out exactly as shown.',
      done: '', touches: 'another-machine', lasts: 'not-a-change', risk: 'none',
      ownerOnly: { reason: 'it clears a refused outward action, which grants authority', instead: 'Ask the owner to approve it with /google approve.' }, operator: AGENT_ONLY, example: { send: '1' },
      run: (values, ctx) => approveRefusedOutwardAction(values.send ?? '', ctx),
    },
    {
      id: 'drop', label: 'Drop a refused send', word: 'drop',
      inputs: [listInput({ id: 'send', label: 'Send', help: 'The sends waiting for approval', list: WAITING_SENDS, other: 'a number /google waiting showed' })],
      sentence: 'Waiting send {send} is dropped and never goes out.',
      done: '', touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', operator: AGENT_ONLY, example: { send: '1' },
      async run(values) {
        const dropped = takeRefusedOutwardAction(Number(values.send));
        if (!dropped) throw commandRefusal(`No waiting send is ${values.send}; nothing was dropped.`, '/google waiting lists them.');
        return `Dropped ${dropped.id}: ${dropped.description}. Nothing was sent.`;
      },
    },
  ];
  return defineCommand<CommandContext>({
    name: 'google',
    title: 'Google',
    summary: 'Connect Gmail and Google Calendar with one consent link, and approve a send the content check refused',
    group: 'Personal',
    report: 'status',
    firstScreenRows: [
      'status', 'connect', 'waiting', 'approve',
      { label: 'Other ways to connect…', actions: ['setup', 'client-file', 'client', 'account', 'calendar-address', 'adopt', 'runbook'] },
      { label: 'Fix or remove the connection…', actions: ['reauthorize', 'forget', 'drop'] },
    ],
    actions,
  });
}

export function registerGoogleRuntimeCommands(registry: CommandRegistry): void {
  registry.register(createGoogleCommand());
}

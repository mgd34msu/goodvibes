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
 * `/email` and `/calendar`. One Google account, one OAuth client and one
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

import type { FeedFetcher } from '@goodvibes-jev/engine/platform/platform/calendar';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { subscriptionRegistryForWrite } from './calendar-subscription-runtime.ts';
import { requireSecretsManager } from './runtime-services.ts';
import { CREDENTIAL_VERB, READ_VERB, ownerOnlyVerb, withCommandVerbs, type CommandVerbs } from './command-verbs.ts';
import { renderGoogleSetupReport } from '@goodvibes-jev/engine/platform/platform/google';
import { renderGoogleSetupRunbook } from '@goodvibes-jev/engine/platform/platform/google';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '@goodvibes-jev/engine/platform/platform/google';
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
import type { GoogleProgressPort, GoogleSetupPath, GoogleSetupStepSpec, GoogleStepResult } from '@goodvibes-jev/engine/platform/platform/google';
import { getOutwardApprovalStore, listRefusedOutwardActions, takeRefusedOutwardAction, type PendingOutwardAction } from '../../trust/outward-approvals.ts';

const USAGE = [
  'Usage: /google <subcommand>',
  '',
  '  connect                         Connect Gmail and Calendar. Works out the shortest route by itself',
  '                                  and asks you for at most one thing: approving a consent link.',
  '  status                          What is connected, proven by reading mail and calendar.',
  '  reauthorize                     Fresh consent covering mail and calendar together. Use this when',
  '                                  something reports a missing scope or a dead credential.',
  '  forget [--yes]                  Remove stored Google credentials. Says what would go and waits.',
  '  adopt [--yes]                   Take up Google credentials from files on this machine (~/.gmail-mcp).',
  '  client-file <path>              Store an OAuth client JSON you already have, then ask for consent.',
  '  client <client-id> <client-secret>',
  '                                  Store an OAuth client id and secret you copied from the console,',
  '                                  then ask for consent. No Cloud project or gcloud step is run.',
  '  account <address>               Set the Gmail address to connect as.',
  '  calendar-address <url>          Store the private iCal address and subscribe to it for read-only calendar access.',
  '  setup [--path app-password|oauth|existing-client]',
  '                                  Run one specific path. /google connect picks for you.',
  '  runbook                         Print the written step-by-step instructions.',
  '  approve [<n>] [--yes|--drop]    Show the sends that were refused; --yes sends the one shown (or number n)',
  '                                  exactly as shown. Type it yourself; it is ignored when the model runs it.',
  '',
  'The same routes are cards in the Agent workspace, under Personal Ops.',
].join('\n');

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

/** The setup path named by `--path`, `app-password` when the flag is absent, null when its value is not a path. */
function parsePath(args: readonly string[]): GoogleSetupPath | null {
  const index = args.indexOf('--path');
  if (index < 0) return 'app-password';
  const value = args[index + 1];
  if (value === 'oauth' || value === 'existing-client' || value === 'app-password') return value;
  return null;
}

/** True when the owner typed an explicit yes on this invocation. */
function saidYes(args: readonly string[]): boolean {
  return args.includes('--yes') || args.includes('-y');
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

async function runSetup(args: readonly string[], ctx: CommandContext): Promise<void> {
  const path = parsePath(args);
  if (path === null) {
    ctx.print('Unknown setup path. Use /google setup --path app-password|oauth|existing-client. Nothing was run.');
    return;
  }
  const report = await runGoogleSetup(path, ctx, progressPort(ctx));
  ctx.print(renderGoogleSetupReport(report));
}

async function setAccount(args: readonly string[], ctx: CommandContext): Promise<void> {
  const address = (args[0] ?? '').trim();
  if (address.length === 0 || !address.includes('@')) {
    ctx.print('Give the Gmail address to connect as: /google account <your-address@gmail.com>');
    return;
  }
  const config = googleConfigPort(ctx);
  config.set(GOOGLE_CONFIG_KEYS.emailUsername, address);
  config.set(GOOGLE_CONFIG_KEYS.emailFromAddress, address);
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
async function setCalendarAddress(args: readonly string[], ctx: CommandContext, fetcher?: FeedFetcher): Promise<void> {
  const url = (args[0] ?? '').trim();
  if (!url.startsWith('https://')) {
    ctx.print('Give the private iCal address: /google calendar-address <https://calendar.google.com/calendar/ical/.../basic.ics>');
    return;
  }
  // Touch the secrets manager through the same accessor the ports use, so an
  // unavailable secret store fails here rather than half-way through a write.
  requireSecretsManager(ctx);
  const registry = subscriptionRegistryForWrite(ctx, fetcher);
  if (registry === null) {
    ctx.print('Nothing was stored: no secret manager is available, and the feed address is stored only as a secret.');
    return;
  }
  const checked = await registry.validate(url, GOOGLE_CALENDAR_SUBSCRIPTION_NAME);
  if (!checked.ok) {
    ctx.print([`Nothing was stored or replaced: the calendar address could not be read (${checked.stage}); the current calendar feed, if any, is kept.`, `  ${checked.detail}`].join('\n'));
    return;
  }
  // The address works. A feed under the same name would refuse the subscribe
  // as a duplicate, so the earlier one is dropped now; its address is held so
  // a subscribe that fails after all puts it back.
  const previousUrl = await googleSecretPort(ctx).get(GOOGLE_SECRET_KEYS.calendarIcsUrl).catch(() => null);
  const replaced = await registry.unsubscribeWithReport(GOOGLE_CALENDAR_SUBSCRIPTION_NAME);
  const subscribed = await registry.subscribe(url, GOOGLE_CALENDAR_SUBSCRIPTION_NAME);
  if (!subscribed.ok) {
    if (!replaced.removed) {
      ctx.print([`Nothing was stored: the calendar address could not be subscribed (${subscribed.stage}).`, `  ${subscribed.detail}`].join('\n'));
      return;
    }
    const restored = typeof previousUrl === 'string' && previousUrl.trim().length > 0
      ? await registry.subscribe(previousUrl, GOOGLE_CALENDAR_SUBSCRIPTION_NAME)
      : null;
    ctx.print([
      restored?.ok
        ? `The new calendar address could not be subscribed (${subscribed.stage}); the previous '${GOOGLE_CALENDAR_SUBSCRIPTION_NAME}' feed was put back.`
        : restored === null
          ? `The new calendar address could not be subscribed (${subscribed.stage}) and the previous '${GOOGLE_CALENDAR_SUBSCRIPTION_NAME}' feed was removed; its address was not stored under the Google setup, so it could not be put back. Run /google calendar-address again.`
          : `The new calendar address could not be subscribed (${subscribed.stage}) and the previous '${GOOGLE_CALENDAR_SUBSCRIPTION_NAME}' feed could not be put back (${restored.ok ? 'unknown' : restored.stage}); its address is still in the secret store. Run /google calendar-address again.`,
      `  ${subscribed.detail}`,
    ].join('\n'));
    return;
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
 * `/google approve`, the gesture that clears an outward-effect refusal. It
 * shows the refused actions, then sends (or creates) the one the owner names,
 * exactly as shown. The bytes approved are the bytes sent: nothing waits on
 * the model to repeat its call word for word.
 *
 * Owner-only (GOOGLE_VERBS): `agent_harness mode:"run_command"` can run any
 * registered command, so without that the remedy would be reachable by
 * exactly the route it exists to defend against: content steers the model,
 * the model runs the command, the approval appears.
 */
async function approveRefusedOutwardAction(rest: readonly string[], ctx: CommandContext): Promise<void> {
  const waiting = listRefusedOutwardActions();
  if (waiting.length === 0) {
    ctx.print('Nothing is waiting for approval. A refused send stays here for five minutes.');
    return;
  }
  const numbers = rest.filter((arg) => /^\d+$/.test(arg)).map(Number);
  const chosen = numbers.length > 0 ? waiting.find((entry) => entry.id === numbers[0]) : waiting.length === 1 ? waiting[0] : undefined;
  if (rest.includes('--drop')) {
    const dropped = chosen && takeRefusedOutwardAction(chosen.id);
    ctx.print(dropped ? `Dropped ${dropped.id}: ${dropped.description}. Nothing was sent.` : 'Name the one to drop: /google approve <n> --drop');
    return;
  }
  if (!chosen || !saidYes(rest)) {
    ctx.print([
      'Refused by the content check, waiting for your approval:',
      ...waiting.flatMap(describePending),
      '',
      waiting.length === 1
        ? 'Send it exactly as shown with: /google approve --yes   (or drop it: /google approve 1 --drop)'
        : 'Send one exactly as shown with: /google approve <n> --yes   (or drop one: /google approve <n> --drop)',
    ].join('\n'));
    return;
  }
  const approved = takeRefusedOutwardAction(chosen.id);
  if (!approved) {
    ctx.print('That approval expired. Ask for the send again.');
    return;
  }
  if (!approved.perform) {
    // No way to perform it from here: grant a one-use approval for the exact
    // content instead, which the next identical call spends.
    const approval = getOutwardApprovalStore().grant({ action: approved.action, surface: 'owner-direct', content: approved.content });
    ctx.print(approval === null
      ? 'Could not record the approval.'
      : `Approved: ${approved.description}. It is tied to that exact content, good once, and expires in five minutes.`);
    return;
  }
  const outcome = await approved.perform();
  ctx.print(outcome.ok ? `Approved and done: ${outcome.text}` : `Approved, but it did not go through: ${outcome.text}`);
  // The model asked for this; it learns how it ended on its next request.
  ctx.session.conversationManager.hostInstructions.set('replay',
    `The owner approved "${approved.description}" with /google approve. ${outcome.ok ? 'Done' : 'It failed'}: ${outcome.text} Do not send it again.`,
    { once: true, append: true });
}

/** `fetcher` replaces the real HTTP feed fetch, for tests. */
export async function runGoogleCommand(args: readonly string[], ctx: CommandContext, fetcher?: FeedFetcher): Promise<void> {
  const sub = (args[0] ?? 'status').trim().toLowerCase();
  const rest = args.slice(1);

  try {
    if (sub === 'status') {
      ctx.print(await describeGoogleConnection(ctx));
      return;
    }
    if (sub === 'connect') {
      const outcome = await connectGoogle(ctx, progressPort(ctx), consentAnnouncer(ctx));
      ctx.print(outcome.text);
      return;
    }
    if (sub === 'reauthorize' || sub === 'reauth') {
      const outcome = await reauthorizeGoogle(ctx, progressPort(ctx), consentAnnouncer(ctx));
      ctx.print(outcome.text);
      return;
    }
    if (sub === 'forget') {
      // Every stored Google credential is in scope, and none of it goes
      // without the owner's yes on this exact invocation.
      const yes = saidYes(rest);
      const receipt = await forgetGoogleCredentials(
        ctx,
        ['refresh-token', 'client-secret', 'app-password', 'calendar-address'],
        yes,
      );
      ctx.print(receipt);
      return;
    }
    if (sub === 'adopt') {
      const outcome = await adoptGoogleCredentials(
        ctx,
        { setup: '/google connect', status: '/google status' },
        { confirmReplace: saidYes(rest) },
      );
      ctx.print(outcome.text);
      return;
    }
    if (sub === 'setup') return await runSetup(rest, ctx);
    if (sub === 'account') return await setAccount(rest, ctx);
    if (sub === 'calendar-address') return await setCalendarAddress(rest, ctx, fetcher);
    if (sub === 'runbook') {
      ctx.print(renderGoogleSetupRunbook());
      return;
    }
    if (sub === 'approve') return await approveRefusedOutwardAction(rest, ctx);
    if (sub === 'client-file') {
      const path = (rest[0] ?? '').trim();
      if (path.length === 0) {
        ctx.print('Give the path to the downloaded client JSON: /google client-file <path>');
        return;
      }
      const outcome = await connectGoogleClient(ctx, { kind: 'client-json-file', path }, progressPort(ctx), consentAnnouncer(ctx));
      ctx.print(outcome.text);
      return;
    }
    if (sub === 'client') {
      const clientId = (rest[0] ?? '').trim();
      const clientSecret = (rest[1] ?? '').trim();
      if (clientId.length === 0 || clientSecret.length === 0) {
        ctx.print('Give both values: /google client <client-id> <client-secret>');
        return;
      }
      const outcome = await connectGoogleClient(ctx, { kind: 'manual-entry', clientId, clientSecret }, progressPort(ctx), consentAnnouncer(ctx));
      ctx.print(outcome.text);
      return;
    }
    ctx.print(USAGE);
  } catch (error) {
    ctx.print(`Google setup could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * What each /google verb does. Anything that stores, adopts, replaces or
 * removes a Google credential, changes the account mail is sent as, or clears
 * an outward-effect refusal is the owner's to type.
 */
const GOOGLE_VERBS: CommandVerbs = {
  defaultVerb: 'status',
  verbs: {
    status: READ_VERB,
    runbook: READ_VERB,
    connect: CREDENTIAL_VERB,
    reauthorize: CREDENTIAL_VERB,
    reauth: CREDENTIAL_VERB,
    setup: CREDENTIAL_VERB,
    forget: ownerOnlyVerb('credential', 'removes every stored Google credential'),
    adopt: ownerOnlyVerb('credential', 'takes up credential files from the home directory'),
    account: ownerOnlyVerb('credential', 'changes the address mail is sent and signed in as'),
    'calendar-address': ownerOnlyVerb('credential', 'stores a private calendar address (a credential) and replaces the current feed'),
    client: ownerOnlyVerb('credential', 'stores a client secret'),
    'client-file': ownerOnlyVerb('credential', 'stores the client secret from a file'),
    approve: ownerOnlyVerb('credential', 'clears a refused outward action, which grants authority'),
  },
  otherwise: READ_VERB,
};

export function registerGoogleRuntimeCommands(registry: CommandRegistry): void {
  registry.register(withCommandVerbs({
    name: 'google',
    aliases: ['gmail'],
    description: 'Connect Gmail and Google Calendar: one command, one consent link, proven by use',
    usage: 'connect | status | reauthorize | forget [--yes] | adopt [--yes] | setup [--path app-password|oauth|existing-client] | client-file <path> | client <id> <secret> | account <address> | calendar-address <url> | runbook | approve [<n>] [--yes|--drop]',
    argsHint: 'connect|status|reauthorize|forget|adopt|setup|client-file|client|account|calendar-address|runbook|approve',
    handler: (args, ctx) => runGoogleCommand(args, ctx),
  }, GOOGLE_VERBS));
}

import { join } from 'node:path';
import { DRIVER_REQUIRED_FILES } from '@goodvibes/engine/platform/platform/browser';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from '@goodvibes/engine/platform/platform/google';
import { driverRemediation } from '../runtime/browser-driver-profile.ts';
import { agentDriverSearchDirectories } from '../runtime/agent-browser.ts';
import { registerCapability, registerFallbackCapability } from './capability-index.ts';
import type { CapabilityDeclaration, CapabilityPrerequisite, CapabilityProbe } from '@goodvibes/engine/terminal-shell/agent-turn/capability-types';

/**
 * The capabilities this build declares for itself.
 *
 * Two kinds live here. Real ones, browser control, declare the route they are
 * actually invoked through. Placeholders, email and calendar, declare what
 * the agent would need in order to do something it cannot do yet, so the index
 * can answer "not yet, and here is exactly why" instead of "no". A provider
 * that implements one of those ids later registers over the placeholder.
 */

export interface BuiltinCapabilityOptions {
  readonly homeDirectory: string;
  readonly workingDirectory: string;
}

/**
 * Browser control, described the way it actually behaves.
 *
 * The driver prerequisite is deliberately OPTIONAL, and that is the whole point
 * of this declaration. In 1.18.1 it was blocking and probed by module
 * resolution alone, which can never succeed inside a compiled binary, so every
 * binary install reported "the browser driver is missing, reinstall the agent",
 * the model relayed that instead of calling the tool, and the tool's own
 * one-act provisioning (which installs the driver on first use) never got a
 * chance to run. A prerequisite the tool provisions for itself is not something
 * the user has to supply, so it does not block; it only annotates.
 *
 * When the driver genuinely cannot be obtained, the failure is reported at call
 * time by the provisioning policy, which has actually tried and can name what
 * stopped it. That is the honest place for it, a probe cannot know.
 */
export function browserControlDeclaration(options: BuiltinCapabilityOptions): CapabilityDeclaration {
  return {
    id: 'browser.control',
    title: 'Use a web browser',
    summary: 'Open web pages, read them, click, type, fill forms, and take screenshots, with a saved profile that keeps sign-ins between runs. The browser driver and browser install themselves on the first call if they are not already there, which takes a minute or two once.',
    provider: 'goodvibes-agent built-in browser tool',
    invocations: [
      {
        kind: 'model-tool',
        toolName: 'browser',
        modelRoute: 'browser action:"navigate" url:"..."',
        availability: { kind: 'model-tool-registered', toolName: 'browser' },
      },
    ],
    prerequisites: [
      {
        id: 'playwright-driver',
        label: 'The browser driver',
        probe: {
          kind: 'module-resolvable',
          specifier: 'playwright-core',
          label: 'The browser driver',
          // The exact places the runtime loads it from, AND the exact
          // completeness rule it applies, so the index agrees with what the
          // browser tool will find a moment later rather than merely looking in
          // the same places.
          // Resolved against the AGENT's storage root, so the index reports on
          // the same directory the browser tool will install into rather than
          // on some other surface's.
          searchDirectories: agentDriverSearchDirectories(options.homeDirectory),
          requiredFiles: DRIVER_REQUIRED_FILES,
        },
        optional: true,
        fix: driverRemediation(),
      },
    ],
  };
}

/**
 * The Google account, and what it makes possible.
 *
 * These were placeholders describing a build that could not send mail. They
 * declared their only route as the daemon operator method `email.send`, which
 * the operator contract carries with `invokable: false`, meaning no daemon
 * dispatch chain serves it. A capability whose sole route is permanently
 * un-invokable resolves to `unavailable` before prerequisites are even read, so
 * configuring a mailbox or adopting credentials moved nothing, and the owner
 * was told email was "not wired into this build" while working credentials sat
 * on disk.
 *
 * They now declare the route that is actually served: the in-process `google`
 * tool, backed by the native connector. The prerequisite is exactly what the
 * connector resolves credentials from: a client id, a client secret and a
 * refresh token in the encrypted store. A credential file left by another tool
 * (`~/.gmail-mcp`) is NOT one: the connector only reads it when the owner runs
 * adopting them (`google.adopt`), so it is configuration evidence, which turns the capability
 * into "needs setup" with the adopt step rather than "ready".
 */

/** What the connector's credential resolution requires; a partial set cannot call anything. */
function googleAccountPrerequisites(): readonly CapabilityPrerequisite[] {
  return [
    {
      id: 'google-client-id',
      label: 'A Google client id',
      probe: { kind: 'config-value-present', key: GOOGLE_CONFIG_KEYS.oauthClientId, label: 'A Google client id' },
      fix: GOOGLE_ACCOUNT_FIX,
    },
    {
      id: 'google-client-secret',
      label: 'A Google client secret',
      probe: { kind: 'secret-present', key: GOOGLE_SECRET_KEYS.oauthClientSecret, label: 'A Google client secret' },
      fix: GOOGLE_ACCOUNT_FIX,
    },
    {
      id: 'google-refresh-token',
      label: 'A Google refresh token',
      probe: { kind: 'secret-present', key: GOOGLE_SECRET_KEYS.oauthRefreshToken, label: 'A Google refresh token' },
      fix: GOOGLE_ACCOUNT_FIX,
    },
  ];
}

/** Credentials another tool left on this machine. Evidence of what could be adopted, never a prerequisite. */
function googleAdoptableEvidence(options: BuiltinCapabilityOptions): CapabilityProbe {
  return {
    kind: 'any-file-present',
    paths: [
      join(options.homeDirectory, '.gmail-mcp', 'gcp-oauth.keys.json'),
      join(options.homeDirectory, '.gmail-mcp', 'google-workspace-credentials.json'),
      join(options.homeDirectory, '.gmail-mcp', 'credentials.json'),
    ],
    label: 'Google credentials already on this machine',
  };
}

const GOOGLE_ACCOUNT_FIX = 'Connect a Google account with "connect" on the Google tab of Mail, calendar and channels (capability google.connect): it works out the shortest route and asks you to approve one consent link';

function emailSend(options: BuiltinCapabilityOptions): CapabilityDeclaration {
  return {
    id: 'email.send',
    title: 'Send email',
    summary: 'Send a message from the owner\'s mailbox.',
    provider: 'goodvibes-agent built-in Google connector',
    invocations: [
      {
        kind: 'model-tool',
        toolName: 'google',
        modelRoute: 'google action:"mail.send" to:"..." subject:"..." body:"..." confirm:true',
        availability: { kind: 'model-tool-registered', toolName: 'google' },
      },
    ],
    prerequisites: googleAccountPrerequisites(),
    configurationEvidence: [googleAdoptableEvidence(options)],
  };
}

function emailRead(options: BuiltinCapabilityOptions): CapabilityDeclaration {
  return {
    id: 'email.read',
    title: 'Read email',
    summary: 'Read messages from the owner\'s mailbox.',
    provider: 'goodvibes-agent built-in Google connector',
    invocations: [
      {
        kind: 'model-tool',
        toolName: 'google',
        modelRoute: 'google action:"mail.list" query:"..."',
        availability: { kind: 'model-tool-registered', toolName: 'google' },
      },
    ],
    prerequisites: googleAccountPrerequisites(),
    configurationEvidence: [googleAdoptableEvidence(options)],
  };
}

function calendarRead(options: BuiltinCapabilityOptions): CapabilityDeclaration {
  return {
    id: 'calendar.read',
    title: 'Read the calendar',
    summary: 'See what is on the owner\'s calendar.',
    provider: 'goodvibes-agent built-in Google connector',
    invocations: [
      {
        kind: 'model-tool',
        toolName: 'google',
        modelRoute: 'google action:"calendar.list"',
        availability: { kind: 'model-tool-registered', toolName: 'google' },
      },
      {
        // A private calendar feed address (google.calendar-address) is
        // subscribed as a feed; calendar.upcoming reads it with no Google
        // account at all (there is no /calendar command).
        kind: 'model-tool',
        toolName: 'capability_run',
        modelRoute: 'capability_run id:"calendar.upcoming" inputs:{"days":"7"}',
        availability: { kind: 'model-tool-registered', toolName: 'capability_run' },
        prerequisites: [
          {
            id: 'google-calendar-feed',
            label: 'A private calendar feed address',
            probe: { kind: 'config-value-present', key: GOOGLE_CONFIG_KEYS.calendarIcsUrl, label: 'A private calendar feed address' },
            fix: 'Store the calendar\'s private address with "calendar by private address" on the Google tab of Mail, calendar and channels (capability google.calendar-address)',
          },
        ],
      },
    ],
    prerequisites: googleAccountPrerequisites(),
    configurationEvidence: [googleAdoptableEvidence(options)],
  };
}

export function registerBuiltinCapabilities(options: BuiltinCapabilityOptions): void {
  registerCapability(browserControlDeclaration(options));
  registerFallbackCapability(emailSend(options));
  registerFallbackCapability(emailRead(options));
  registerFallbackCapability(calendarRead(options));
}

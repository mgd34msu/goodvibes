/**
 * offer-copy.ts, plain-language copy for the pairing offer set, the one
 * honest LAN-posture line, and the labeled browser-capability list.
 *
 * Each offer names, in plain terms, what accepting it does and what declining it
 * costs, no security jargon, just the concrete consequence. Every offer is
 * independently declinable; a pairing without any accepted offer still pairs the
 * device (it just signs in with none of the extras).
 *
 * The one honest LAN line and the per-capability availability both come from
 * the posture (describeOriginPosture / the `posture` field on a handoff), so
 * every surface renders the SAME truth: the exact LAN_PLAIN_HTTP_NOTICE wording
 * only when the posture carries it, and each browser-gated capability labeled
 * with whether the paired device gets it (and why not, when it does not).
 */
import type { BrowserGatedCapability, OriginPosture } from './origin-posture.js';
import type { PairingHandoffOfferKind } from './pairing-handoff.js';

export interface PairingOfferCopy {
  readonly title: string;
  /** One plain-language line: what accepting does, and what declining leaves you with. */
  readonly consequence: string;
}

export const PAIRING_OFFER_COPY: Record<PairingHandoffOfferKind, PairingOfferCopy> = {
  notifications: {
    title: 'Notifications',
    consequence: 'This device gets a push when an agent needs your input or a run finishes. Decline and it pairs without push.',
  },
  relay: {
    title: 'Relay',
    consequence: 'Reach this daemon from off the LAN through the rendezvous relay, which sees only ciphertext and connection metadata. Decline to stay LAN-only.',
  },
  passkey: {
    title: 'Passkey',
    consequence: 'Register a passkey on this device to confirm sensitive actions with a tap. Decline and sensitive actions ask another way.',
  },
};

/** The offer set as `label, consequence` lines, in the given order. */
export function formatPairingOffers(offers: readonly PairingHandoffOfferKind[]): string[] {
  return offers.map((kind) => {
    const copy = PAIRING_OFFER_COPY[kind];
    return `  ${copy.title}, ${copy.consequence}`;
  });
}

/** One line of the numbered list `pair` leads with: what is done, what is next, what comes after. */
export interface PairingStep {
  readonly state: 'done' | 'next' | 'then';
  readonly text: string;
  /** A second line under the step, when it needs its reason. */
  readonly detail?: string | undefined;
  /** True when `text` is a command, run in a terminal on the daemon's machine (a browser says so; a terminal prints it as is). */
  readonly command?: boolean | undefined;
}

/**
 * The steps for a code a phone could not open: the web UI is served; the one
 * command that lets other devices reach it, with why; then `then`, the
 * pair-again sentence of whoever shows it.
 */
export function pairingUnreachableSteps(
  origin: string,
  reach: { readonly reason?: string | undefined; readonly fix?: string | undefined },
  then: string,
): PairingStep[] {
  return [
    { state: 'done', text: `The daemon serves the web UI at ${origin}.` },
    reach.fix
      ? { state: 'next', text: reach.fix, command: true, ...(reach.reason ? { detail: `(${reach.reason})` } : {}) }
      : { state: 'next', text: 'Make the web UI reachable from your network.', ...(reach.reason ? { detail: `(${reach.reason})` } : {}) },
    { state: 'then', text: then },
  ];
}

/** The pair-again sentence the daemon puts in its answer, for a client that has no command of its own (the web UI). */
export const PAIRING_PAIR_AGAIN = 'Pair again, then scan the new code with the phone.';

/** The steps as `  1. done  text` lines, a detail indented under its step. */
export function formatPairingSteps(steps: readonly PairingStep[]): string[] {
  return steps.flatMap((step, index) => {
    const head = `  ${index + 1}. ${step.state.padEnd(4)}  `;
    return [`${head}${step.text}`, ...(step.detail ? [`${' '.repeat(head.length)}${step.detail}`] : [])];
  });
}

/**
 * What `pair` prints instead of a code a phone could not open: that no code
 * was made, then the list (the web UI is served; the one command that lets
 * other devices reach it, with why; pair again). `pairCommand` is the command
 * of the program printing it.
 */
export function pairingUnreachableLines(origin: string, reach: { readonly reason?: string | undefined; readonly fix?: string | undefined }, pairCommand: string): string[] {
  return [
    'No pairing code was made: a phone could not open it yet.',
    ...formatPairingSteps(pairingUnreachableSteps(origin, reach, `${pairCommand}, then scan the code it prints with the phone.`)),
  ];
}

/** What `pair` prints when the daemon serves no web UI, so a code would open nothing. */
export function pairingNoWebUiLines(pairCommand: string): string[] {
  return [
    'No pairing code was made: the daemon serves no web UI, so a code would open nothing.',
    ...formatPairingSteps([
      { state: 'next', text: 'goodvibes-daemon webui enable --lan', detail: '(serves the web UI to this machine and your network)' },
      { state: 'then', text: `${pairCommand}, then scan the code it prints with the phone.` },
    ]),
  ];
}

/** The list `pair` leads with when it prints a code: the web UI is reachable, scan, then the offers. */
export function pairingReadySteps(origin: string, offers: readonly PairingHandoffOfferKind[]): string[] {
  return formatPairingSteps([
    { state: 'done', text: `The daemon serves the web UI at ${origin}, open to other devices.` },
    { state: 'next', text: 'Scan the code below with the phone\'s camera; it opens the web app already signed in.' },
    { state: 'then', text: offers.length > 0
      ? `In the web app, accept or decline each offer: ${offers.map((kind) => PAIRING_OFFER_COPY[kind].title).join(', ')}.`
      : 'Nothing else: the phone is paired once the web app opens.' },
  ]);
}

/**
 * Plain-language label for each browser-gated capability the posture reports,
 * what the paired device would actually get, named without jargon.
 */
export const POSTURE_CAPABILITY_LABEL: Record<BrowserGatedCapability, string> = {
  'service-worker': 'Offline app (installable / background sync)',
  push: 'Push notifications',
  microphone: 'Voice input (microphone)',
};

/**
 * The one honest LAN line to render, or null. This is the platform posture's own
 * `notice` field verbatim (LAN_PLAIN_HTTP_NOTICE), present ONLY for the
 * plain-http-on-LAN posture, absent (and so never a nag) everywhere else.
 */
export function pairingPostureNotice(posture: OriginPosture | undefined): string | null {
  return posture?.notice ?? null;
}

/**
 * The labeled capability list from the posture: each browser-gated capability as
 * a `Label, available` / `Label, <reason>` line, so the pairing surface lists
 * what the paired device will get instead of hiding a dead button. Empty when no
 * posture is known.
 */
export function formatPostureCapabilities(posture: OriginPosture | undefined): string[] {
  if (!posture) return [];
  return posture.capabilities.map((cap) => {
    const label = POSTURE_CAPABILITY_LABEL[cap.capability as BrowserGatedCapability] ?? cap.capability;
    const status = cap.available ? 'available' : (cap.reason ?? 'unavailable');
    return `  ${label}, ${status}`;
  });
}

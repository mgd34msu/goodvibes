/**
 * Tailscale serve (Devices and network): what the daemon reports about Tailscale, serving the daemon at its https tailnet
 * address, and stopping that. Each is the daemon's own method (`tailscale.get`, `tailscale.serve.run`,
 * `tailscale.serve.stop`), run as a capability (method-capability.ts), so the place's controls, the web UI, a model and a
 * script reach the one implementation, which keeps its own effects and confirmation.
 */
import type { MethodCapabilityDefinition } from './method-capability.js';
import { throughMethod } from './devices.js';

type Answer = Readonly<Record<string, unknown>>;
const record = (value: unknown): Answer => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Answer : {});
const word = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
const at = (value: unknown): string => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') : '');
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** A receipt of a serve or a stop, in words: what it did, where, and when. */
function receiptWords(receipt: Answer): string {
  const when = at(receipt.at);
  const detail = word(receipt.detail);
  const enable = word(receipt.enableUrl);
  return [
    receipt.ok === true ? (word(receipt.url) && receipt.action !== 'stop' ? `Serving at ${word(receipt.url)}.` : sentence(detail || 'Done')) : sentence(detail || 'It did not work'),
    ...(receipt.ok !== true && enable ? [`Turn on Serve for your tailnet at ${enable}.`] : []),
    ...(when ? [`(${when})`] : []),
  ].join(' ');
}

export const TAILSCALE_STATUS = throughMethod({
  id: 'tailscale.status', repeat: 'safe', actionId: 'status', label: 'See whether Tailscale can serve this daemon', word: 'status', inputs: [],
  sentence: 'Says whether Tailscale is here and signed in, the https name it would serve at, whether this daemon is served now, and what the last serve did.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
}, { id: 'tailscale.get', fields: {} },
(answer) => {
  const lines: string[] = [];
  if (answer.available !== true) lines.push(`Tailscale is not usable here: ${sentence(word(answer.detail) || 'it was not found')}`);
  else if (answer.loggedIn !== true) lines.push(`Tailscale is here but not signed in: ${sentence(word(answer.detail) || 'sign in with the Tailscale app')}`);
  else lines.push(word(answer.magicDnsName) ? `Tailscale is signed in as ${word(answer.magicDnsName)}${word(answer.httpsUrl) ? `; it would serve this daemon at ${word(answer.httpsUrl)}` : ''}.` : sentence(word(answer.detail) || 'Tailscale is signed in'));
  const active = record(answer.activeServe);
  if (Object.keys(active).length > 0) lines.push(`This daemon is served now${word(active.url) ? ` at ${word(active.url)}` : ''}; "Stop serving over Tailscale" ends it.`);
  const last = record(answer.lastServe);
  if (Object.keys(last).length > 0) lines.push(`Last time: ${receiptWords(last)}`);
  return lines.join('\n');
});

export const TAILSCALE_SERVE = throughMethod({
  id: 'tailscale.serve', repeat: 'safe', actionId: 'serve', label: 'Serve this daemon over Tailscale', word: 'serve', inputs: [],
  sentence: 'Tailscale serves this daemon at its https address on your tailnet and handles the certificate, and the address phones and links use is set to it, until you stop it; running it again is safe.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'stop-serving',
  ownerOnly: { reason: 'it opens this daemon on your tailnet', instead: 'See whether Tailscale can serve this daemon, in the Devices and network place.' },
  example: {},
}, { id: 'tailscale.serve.run', fields: {} },
(answer) => {
  const lines = [receiptWords(record(answer.receipt))];
  if (answer.publicBaseUrlUpdated === true) lines.push('The address used for links and pairing codes is now the https address.');
  return lines.join('\n');
});

export const TAILSCALE_STOP = throughMethod({
  id: 'tailscale.stop-serving', repeat: 'safe', actionId: 'stop-serving', label: 'Stop serving this daemon over Tailscale', word: 'stop-serving', inputs: [],
  sentence: 'The https tailnet address stops working, and links and pairing codes go back to the address used before.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'serve', example: {},
}, { id: 'tailscale.serve.stop', fields: {} },
(answer) => {
  const lines = [receiptWords(record(answer.receipt))];
  const detail = word(answer.publicBaseUrlDetail);
  if (detail) lines.push(sentence(detail));
  return lines.join('\n');
});

/** Every Tailscale capability: each runs through its own daemon method. */
export const TAILSCALE_CAPABILITIES: readonly MethodCapabilityDefinition[] = [TAILSCALE_STATUS, TAILSCALE_SERVE, TAILSCALE_STOP];

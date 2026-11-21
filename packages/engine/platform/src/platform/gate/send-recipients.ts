/**
 * Sends whose recipients code reads from the call itself, for the calls no
 * tool declaration covers: a shell command that mails or posts a message, a
 * `fetch` request to a messaging service, and an MCP server or plugin tool
 * whose arguments name a person to send to. No model; the only I/O is reading
 * a shell script a command runs.
 *
 * Each rule names a program, a service endpoint or an argument name, and
 * where its recipients sit:
 *
 *  - shell mail programs (`mail`, `mailx`, `s-nail`, `sendmail`, `msmtp`,
 *    `ssmtp`, `mutt`, `neomutt`, `swaks`) and the Twilio CLI, from their
 *    arguments, read by the gate's one command walk (command-walk.ts): through
 *    `sudo`, `setsid` and the other wrappers, `sh -c` strings, `$(...)` and
 *    the shell scripts a command runs;
 *  - an HTTP request (`fetch`, `curl`, `wget`, HTTPie) to a messaging
 *    service's send endpoint: for a webhook the URL is the recipient (as
 *    `agent_channel_send` compares one); for a service that takes the
 *    recipient in the request (Telegram, Twilio, SendGrid, Mailgun, Postmark,
 *    Resend, the Slack and Microsoft Graph and Gmail send APIs) its recipient
 *    fields, from the URL query, a JSON or form body, or the message headers;
 *  - an MCP server or plugin tool, not declared read-only, whose arguments
 *    `to`, `cc`, `bcc`, `recipient(s)`, `attendees` or `invitees` hold mail
 *    addresses or phone numbers. A tool that only saves a draft sends nothing.
 *
 * A send these rules recognise whose recipients cannot be read (`sendmail -t`,
 * a body read from a file, a body that is not JSON or a form), and a command
 * nested too deeply or a script too large to read, is reported as
 * unreadable, and the caller treats it as a recipient nobody allowed. What no
 * rule names (a URL or address held in a shell variable or a file, a script
 * that sends from inside a program, a page the browser types into) is not
 * recognised here.
 *
 * Cost per call: nothing for a tool that runs no command, is not `fetch` and
 * declares its effects; one parse of each command string for a call that runs
 * commands, and one stat and read per shell script a command runs; a walk of
 * the arguments for an undeclared tool.
 */
import type { ToolDefinition } from '../types/tools.js';
import { walkCommands } from './command-walk.js';

/**
 * What a call sends to: the recipients read from it (empty when it sends to
 * no recipient these rules recognise), or `undefined` when it is a send whose
 * recipients cannot be read.
 */
export type SendRecipients = readonly string[] | undefined;

/** Fields of a request, by lowercased name, as read from its query, body or form. */
type Fields = Map<string, unknown[]>;

const isAddress = (value: string): boolean => /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value);
const isPhone = (value: string): boolean => /^\+?[0-9][0-9 ().-]{6,20}$/.test(value) && value.replace(/\D/g, '').length >= 7;
/** One mail address or phone number written as a person writes it: `Bob <bob@x.org>`, `bob@x.org`, `+1 555 0100`. */
function addressIn(value: string): string | undefined {
  const trimmed = value.trim();
  const angled = /<([^<>]+)>\s*$/.exec(trimmed)?.[1]?.trim();
  const candidate = (angled ?? trimmed).replace(/^mailto:/i, '');
  return isAddress(candidate) || isPhone(candidate) ? candidate : undefined;
}

function addField(fields: Fields, name: string, value: unknown): void {
  const key = name.trim().toLowerCase();
  if (!key) return;
  const list = fields.get(key);
  if (list) list.push(value); else fields.set(key, [value]);
}

/** `a=b&c=d` into fields; false when the text is not a form. */
function addForm(fields: Fields, text: string): boolean {
  if (!/^[^=&\s]+=/.test(text.trim())) return false;
  for (const pair of text.trim().split('&')) {
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    try { addField(fields, decodeURIComponent(pair.slice(0, at).replace(/\+/g, ' ')), decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '))); }
    catch { addField(fields, pair.slice(0, at), pair.slice(at + 1)); }
  }
  return true;
}

/** A JSON object's top-level members into fields; false when the text is not one. */
function addJson(fields: Fields, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) addField(fields, key, value);
    return true;
  } catch {
    return false;
  }
}

/** A request body as written: JSON, or a form. False when it is neither (it cannot be read). */
function addBody(fields: Fields, text: string): boolean {
  return addJson(fields, text) || addForm(fields, text);
}

/** Names under which an address sits inside a recipient entry: `{ email }`, `{ emailAddress: { address } }`, `{ phone }`. */
const ADDRESS_LEAVES: ReadonlySet<string> = new Set(['email', 'address', 'emailaddress', 'phone', 'number', 'id', 'chat_id']);

/** Every text value of a recipient field: a string, each entry of a list, the address leaves of an object. */
function leaves(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value === undefined || value === null) return;
  if (typeof value === 'string') { out.push(...value.split(/[,;]/).map((part) => part.trim()).filter((part) => part.length > 0)); return; }
  if (typeof value === 'number') { out.push(String(value)); return; }
  if (Array.isArray(value)) { for (const entry of value) leaves(entry, out, depth + 1); return; }
  if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      const name = key.toLowerCase();
      if (ADDRESS_LEAVES.has(name) || name === 'to' || name === 'cc' || name === 'bcc') leaves(inner, out, depth + 1);
    }
  }
}

/**
 * The values of `keys` in the fields, and in the entries of a list of
 * messages (`personalizations[]`, `message`). Empty when none is present.
 */
function recipientValues(fields: Fields, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) for (const value of fields.get(key) ?? []) leaves(value, out);
  for (const container of ['personalizations', 'message', 'messages']) {
    for (const value of fields.get(container) ?? []) {
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const inner: Fields = new Map();
        for (const [name, member] of Object.entries(entry as Record<string, unknown>)) addField(inner, name, member);
        out.push(...recipientValues(inner, keys));
      }
    }
  }
  return out;
}

/** `To:`, `Cc:` and `Bcc:` of a message as written (headers, then a blank line). */
function headerRecipients(message: string): string[] {
  const head = message.split(/\r?\n\r?\n/, 1)[0] ?? '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const out: string[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^(to|cc|bcc)\s*:(.*)$/i.exec(line);
    if (match) leaves(match[2], out);
  }
  return out;
}

/** A messaging service's send endpoint, and where the recipients of a request to it sit. */
interface SendEndpoint {
  readonly host: (host: string) => boolean;
  readonly path: RegExp;
  /** `url`: the URL itself names where the message goes (a webhook). Else the recipient field names, lowercased. */
  readonly recipients: 'url' | 'raw-message' | readonly string[];
}

const SEND_ENDPOINTS: readonly SendEndpoint[] = [
  // Webhooks: the URL is the destination.
  { host: (host) => host === 'hooks.slack.com', path: /^\/(?:services|workflows|triggers)\//, recipients: 'url' },
  { host: (host) => /^(?:(?:ptb|canary)\.)?discord(?:app)?\.com$/.test(host), path: /^\/api\/(?:v\d+\/)?webhooks\//, recipients: 'url' },
  { host: (host) => host === 'chat.googleapis.com', path: /^\/v1\/spaces\/[^/]+\/messages/, recipients: 'url' },
  { host: (host) => host.endsWith('.webhook.office.com') || host === 'outlook.office.com' || host === 'outlook.office365.com', path: /^\/webhook/i, recipients: 'url' },
  { host: (host) => host === 'ntfy.sh', path: /^\/[^/?#]+\/?$/, recipients: 'url' },
  // Services that take the recipient in the request.
  { host: (host) => host === 'api.telegram.org', path: /^\/bot[^/]+\/(?:send\w+|forwardmessages?|copymessages?)$/i, recipients: ['chat_id'] },
  { host: (host) => host === 'api.twilio.com', path: /\/(?:messages|calls)(?:\.json)?$/i, recipients: ['to'] },
  { host: (host) => host === 'api.sendgrid.com', path: /^\/v3\/mail\/send/, recipients: ['to', 'cc', 'bcc'] },
  { host: (host) => host === 'api.mailgun.net' || host === 'api.eu.mailgun.net', path: /^\/v3\/[^/]+\/messages/, recipients: ['to', 'cc', 'bcc'] },
  { host: (host) => host === 'api.postmarkapp.com', path: /^\/email/i, recipients: ['to', 'cc', 'bcc'] },
  { host: (host) => host === 'api.resend.com', path: /^\/emails/, recipients: ['to', 'cc', 'bcc'] },
  { host: (host) => host === 'slack.com', path: /^\/api\/chat\.(?:postmessage|schedulemessage|postephemeral)$/i, recipients: ['channel'] },
  { host: (host) => host === 'graph.microsoft.com', path: /\/sendmail$/i, recipients: ['torecipients', 'ccrecipients', 'bccrecipients'] },
  { host: (host) => host === 'gmail.googleapis.com' || host === 'www.googleapis.com', path: /\/messages\/send$/, recipients: 'raw-message' },
];

/** The send endpoint a URL names, or undefined. A URL written without a scheme is read as https. */
function sendEndpointOf(raw: string): { readonly url: URL; readonly endpoint: SendEndpoint } | undefined {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return undefined;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); }
  catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase();
  const endpoint = SEND_ENDPOINTS.find((candidate) => candidate.host(host) && candidate.path.test(url.pathname));
  return endpoint ? { url, endpoint } : undefined;
}

/**
 * The recipients of one request to a send endpoint: the URL for a webhook,
 * else the recipient fields read from its query and body (`fields`, or
 * `undefined` when the body cannot be read). `undefined` when they cannot be read.
 */
function endpointRecipients(url: URL, endpoint: SendEndpoint, body: Fields | undefined): SendRecipients {
  if (endpoint.recipients === 'url') return [url.href];
  const fields: Fields = new Map(body ?? []);
  for (const [key, value] of url.searchParams) addField(fields, key, value);
  if (endpoint.recipients === 'raw-message') {
    const raw = fields.get('raw')?.find((value): value is string => typeof value === 'string');
    if (raw === undefined) return undefined;
    const found = headerRecipients(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return found.length > 0 ? found : undefined;
  }
  const found = recipientValues(fields, endpoint.recipients);
  return found.length > 0 ? found : undefined;
}

/** Joins what several parts send to: unreadable when any part is. */
function joined(parts: readonly SendRecipients[]): SendRecipients {
  const out: string[] = [];
  for (const part of parts) {
    if (part === undefined) return undefined;
    out.push(...part);
  }
  return out;
}

// ── fetch ────────────────────────────────────────────────────────────────

/** What a `fetch` call sends to: each request to a send endpoint (any method but HEAD and OPTIONS). */
function fetchRecipients(args: Record<string, unknown>): SendRecipients {
  const requests = Array.isArray(args['urls']) ? args['urls'] as unknown[] : typeof args['url'] === 'string' ? [args] : [];
  const parts: SendRecipients[] = [];
  for (const request of requests) {
    if (!request || typeof request !== 'object') continue;
    const entry = request as Record<string, unknown>;
    const target = typeof entry['url'] === 'string' ? sendEndpointOf(entry['url']) : undefined;
    if (!target) continue;
    const method = typeof entry['method'] === 'string' ? entry['method'].toUpperCase() : 'GET';
    if (method === 'HEAD' || method === 'OPTIONS') continue;
    const fields: Fields = new Map();
    let readable = true;
    const params = entry['params'];
    if (params && typeof params === 'object' && !Array.isArray(params)) for (const [key, value] of Object.entries(params)) addField(fields, key, value);
    const data = entry['body_data'];
    if (data && typeof data === 'object' && !Array.isArray(data)) for (const [key, value] of Object.entries(data)) addField(fields, key, value);
    const text = typeof entry['body'] === 'string' ? entry['body']
      : typeof entry['body_base64'] === 'string' ? Buffer.from(entry['body_base64'], 'base64').toString('utf8') : undefined;
    if (text !== undefined && text.trim().length > 0 && !addBody(fields, text)) readable = false;
    parts.push(endpointRecipients(target.url, target.endpoint, readable ? fields : undefined));
  }
  return joined(parts);
}

// ── shell commands ───────────────────────────────────────────────────────

const MAIL_PROGRAMS: ReadonlySet<string> = new Set(['mail', 'mailx', 's-nail', 'bsd-mailx', 'heirloom-mailx', 'nail']);
const SENDMAIL_PROGRAMS: ReadonlySet<string> = new Set(['sendmail', 'msmtp', 'ssmtp', 'sendmail.postfix', 'exim', 'exim4', 'esmtp']);
const MUTT_PROGRAMS: ReadonlySet<string> = new Set(['mutt', 'neomutt']);
const HTTP_PROGRAMS: ReadonlySet<string> = new Set(['curl', 'wget', 'http', 'https', 'xh', 'xhs']);

/** The non-option words of a program, given the options that take a value; `--` ends the options. */
function operands(args: readonly string[], valued: ReadonlySet<string>): { readonly words: string[]; readonly values: Map<string, string[]> } {
  const words: string[] = [];
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (word === '--') { words.push(...args.slice(index + 1)); break; }
    if (!word.startsWith('-') || word === '-') { words.push(word); continue; }
    const eq = word.indexOf('=');
    const flag = eq > 0 && word.startsWith('--') ? word.slice(0, eq) : word;
    if (!valued.has(flag)) {
      // A short flag carrying its value (`-cbob@x.org`) where the letter takes one.
      const short = !word.startsWith('--') && word.length > 2 ? `-${word[1]}` : undefined;
      if (short !== undefined && valued.has(short)) values.set(short, [...(values.get(short) ?? []), word.slice(2)]);
      continue;
    }
    const value = eq > 0 && word.startsWith('--') ? word.slice(eq + 1) : args[++index];
    if (value !== undefined) values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  return { words, values };
}

const split = (values: readonly string[]): string[] => values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter((value) => value.length > 0);

/** What one mail program run sends to; `[]` when the run only reads mail; undefined when its recipients cannot be read. */
function mailRecipients(name: string, args: readonly string[]): SendRecipients | null {
  if (MAIL_PROGRAMS.has(name)) {
    // Reading a mailbox (`-f`, `-u`, `-e`, `-H`) or no recipient at all sends nothing.
    if (args.some((word) => word === '-f' || word === '-u' || word === '-e' || word === '-H' || word.startsWith('--file'))) return null;
    const { words, values } = operands(args, new Set(['-s', '-c', '-b', '-r', '-a', '-A', '-S', '-q', '-T', '-j', '--subject', '--cc', '--bcc', '--attach', '--append', '--return-address', '--content-type']));
    const found = [...split(words), ...split(values.get('-c') ?? []), ...split(values.get('-b') ?? []), ...split(values.get('--cc') ?? []), ...split(values.get('--bcc') ?? [])];
    return found.length > 0 ? found : null;
  }
  if (SENDMAIL_PROGRAMS.has(name)) {
    // `-t` takes the recipients from the message on standard input: they cannot be read here.
    if (args.some((word) => word === '-t' || word === '--read-recipients' || (/^-[A-Za-z]*t[A-Za-z]*$/.test(word) && !word.startsWith('--')))) {
      // `-bp`, `-bt` and the like are queue and test modes, not sends.
      if (args.some((word) => /^-b[a-z]$/.test(word) && word !== '-bm')) return null;
      return undefined;
    }
    if (args.some((word) => /^-b[a-z]$/.test(word) && word !== '-bm') || args.some((word) => word === '-q' || /^-q\w/.test(word))) return null;
    const { words } = operands(args, new Set(['-f', '-F', '-o', '-C', '-a', '-B', '-N', '-R', '-V', '-X', '-L', '-h', '--from', '--account', '--file', '--host', '--port']));
    const found = split(words);
    return found.length > 0 ? found : undefined;
  }
  if (MUTT_PROGRAMS.has(name)) {
    if (args.some((word) => word === '-f' || word === '-y' || word === '-Z' || word === '-z' || word === '-Q' || word === '-v' || word === '-D')) return null;
    // `-H` sends a draft file whose recipients cannot be read here.
    if (args.includes('-H')) return undefined;
    // After `-a`, files run up to `--`; recipients follow it.
    const end = args.indexOf('--');
    const attach = args.indexOf('-a');
    const head = attach >= 0 && end > attach ? [...args.slice(0, attach), ...args.slice(end)] : args;
    const { words, values } = operands(head, new Set(['-s', '-c', '-b', '-a', '-F', '-e', '-i', '-m', '-n']));
    const found = [...split(words), ...split(values.get('-c') ?? []), ...split(values.get('-b') ?? [])];
    return found.length > 0 ? found : null;
  }
  if (name === 'swaks') {
    const { values } = operands(args, new Set(['-t', '--to', '-f', '--from', '-s', '--server', '-p', '--port', '--h-subject', '--header', '--body', '--data', '-d', '-au', '--auth-user', '-ap', '--auth-password', '--attach']));
    const found = split([...(values.get('-t') ?? []), ...(values.get('--to') ?? [])]);
    return found.length > 0 ? found : undefined;
  }
  if (name === 'twilio' && args.some((word) => /(?:messages|calls):create$/.test(word))) {
    const { values } = operands(args, new Set(['--to', '--from', '--body', '--url', '-p', '--profile', '-o']));
    const found = split(values.get('--to') ?? []);
    return found.length > 0 ? found : undefined;
  }
  return null;
}

/** curl options whose value is a request body (or part of one). */
const CURL_BODY = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json']);
const CURL_FORM = new Set(['-F', '--form', '--form-string', '--data-urlencode']);
/** curl options that take a value, as single letters and long names. */
const CURL_VALUED = new Set([
  ...CURL_BODY, ...CURL_FORM, '-X', '--request', '-T', '--upload-file', '-H', '--header', '-u', '--user', '-o', '--output', '-A', '--user-agent',
  '-e', '--referer', '-b', '--cookie', '-c', '--cookie-jar', '-x', '--proxy', '-m', '--max-time', '--connect-timeout', '-w', '--write-out',
  '-K', '--config', '--url', '-E', '--cert', '--key', '--cacert', '--retry', '--retry-delay', '--retry-max-time', '--resolve', '--interface',
  '-r', '--range', '-U', '--proxy-user', '--oauth2-bearer', '-z', '--time-cond', '--limit-rate', '-Y', '-y', '--max-filesize', '--variable',
  '--connect-to', '--dns-servers', '-C', '--continue-at', '-P', '--ftp-port', '-Q', '--quote', '-t', '--telnet-option', '--trace', '--trace-ascii',
]);

/** What one curl run sends to a messaging service. */
function curlRecipients(args: readonly string[]): SendRecipients {
  const urls: string[] = [];
  const fields: Fields = new Map();
  let readable = true;
  let head = false;
  let method: string | undefined;
  const take = (flag: string, value: string) => {
    if (flag === '-X' || flag === '--request') method = value.toUpperCase();
    else if (flag === '--url') urls.push(value);
    else if (CURL_BODY.has(flag)) { if (value.startsWith('@') || !addBody(fields, value)) readable = false; }
    else if (CURL_FORM.has(flag)) {
      const at = value.indexOf('=');
      if (at > 0) {
        const content = value.slice(at + 1);
        if (flag !== '--form-string' && (content.startsWith('@') || content.startsWith('<'))) readable = false;
        else addField(fields, value.slice(0, at), content);
      } else if (flag === '--data-urlencode' && !value.startsWith('@')) {
        if (!addForm(fields, value)) readable = false;
      } else readable = false;
    } else if (flag === '-T' || flag === '--upload-file') readable = false;
  };
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (word === '-I' || word === '--head') { head = true; continue; }
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const flag = eq > 0 ? word.slice(0, eq) : word;
      if (CURL_VALUED.has(flag)) {
        const value = eq > 0 ? word.slice(eq + 1) : args[++index];
        if (value !== undefined) take(flag, value);
      }
      continue;
    }
    if (word.startsWith('-') && word.length > 1) {
      // A cluster of short options; the first that takes a value takes the rest of the word or the next one.
      for (let at = 1; at < word.length; at++) {
        const flag = `-${word[at]}`;
        if (flag === '-I') { head = true; continue; }
        if (!CURL_VALUED.has(flag)) continue;
        const value = at + 1 < word.length ? word.slice(at + 1) : args[++index];
        if (value !== undefined) take(flag, value);
        break;
      }
      continue;
    }
    urls.push(word);
  }
  if (head || method === 'HEAD' || method === 'OPTIONS') return [];
  const parts: SendRecipients[] = [];
  for (const raw of urls) {
    const target = sendEndpointOf(raw);
    if (target) parts.push(endpointRecipients(target.url, target.endpoint, readable ? fields : undefined));
  }
  return joined(parts);
}

/** What one wget run sends to a messaging service. */
function wgetRecipients(args: readonly string[]): SendRecipients {
  if (args.includes('--spider')) return [];
  const fields: Fields = new Map();
  let readable = true;
  const parts: SendRecipients[] = [];
  const urls: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const eq = word.indexOf('=');
    const flag = word.startsWith('--') && eq > 0 ? word.slice(0, eq) : word;
    const value = word.startsWith('--') && eq > 0 ? word.slice(eq + 1) : undefined;
    if (flag === '--post-data' || flag === '--body-data') { const body = value ?? args[++index]; if (body === undefined || !addBody(fields, body)) readable = false; continue; }
    if (flag === '--post-file' || flag === '--body-file') { readable = false; if (value === undefined) index++; continue; }
    if (word.startsWith('-')) continue;
    urls.push(word);
  }
  for (const raw of urls) {
    const target = sendEndpointOf(raw);
    if (target) parts.push(endpointRecipients(target.url, target.endpoint, readable ? fields : undefined));
  }
  return joined(parts);
}

/** What one HTTPie (`http`, `https`, `xh`) run sends to a messaging service: its URL and its `key=value`, `key:=json` and `key==query` items. */
function httpieRecipients(args: readonly string[]): SendRecipients {
  const words = args.filter((word) => !word.startsWith('-'));
  // The URL is the first word naming a send endpoint (an option's value, such as `-a user:pass`, names none); the items follow it.
  const at = words.findIndex((word) => sendEndpointOf(word) !== undefined);
  if (at < 0) return [];
  if (at > 0 && /^(?:HEAD|OPTIONS)$/i.test(words[at - 1]!)) return [];
  const target = sendEndpointOf(words[at]!)!;
  const fields: Fields = new Map();
  let readable = true;
  const raw = args.find((word) => word.startsWith('--raw='));
  if (raw !== undefined && !addBody(fields, raw.slice('--raw='.length))) readable = false;
  for (const item of words.slice(at + 1)) {
    const json = /^([^:=@]+):=(.*)$/s.exec(item);
    if (json) { try { addField(fields, json[1]!, JSON.parse(json[2]!)); } catch { addField(fields, json[1]!, json[2]); } continue; }
    const query = /^([^:=@]+)==(.*)$/s.exec(item);
    if (query) { addField(fields, query[1]!, query[2]); continue; }
    const file = /^([^:=@]+)=?@/.exec(item);
    if (file) { readable = false; continue; }
    const field = /^([^:=@]+)=(.*)$/s.exec(item);
    if (field) addField(fields, field[1]!, field[2]);
  }
  return endpointRecipients(target.url, target.endpoint, readable ? fields : undefined);
}

/** What one program run sends to; null when it is not a send these rules recognise. */
function programRecipients(name: string, args: readonly string[]): SendRecipients | null {
  const mail = mailRecipients(name, args);
  if (mail !== null) return mail;
  if (!HTTP_PROGRAMS.has(name)) return null;
  const found = name === 'curl' ? curlRecipients(args) : name === 'wget' ? wgetRecipients(args) : httpieRecipients(args);
  return found !== undefined && found.length === 0 ? null : found;
}

/**
 * What the shell commands send to, read by the gate's one command walk;
 * `directory` is where a relative script path is read from.
 */
export function commandRecipients(commands: readonly string[], directory: string | undefined): SendRecipients {
  if (commands.length === 0) return [];
  const out: string[] = [];
  let unreadable = false;
  const cannotRead = (): undefined => { unreadable = true; return undefined; };
  // The walk stops at the first answer; this visitor collects and never answers, so every program is read.
  walkCommands<true>(commands, (run) => {
    const found = programRecipients(run.name, run.args);
    if (found === undefined) unreadable = true;
    else if (found !== null) out.push(...found);
    return undefined;
  }, { directory, tooDeep: cannotRead, onScriptTooLarge: cannotRead });
  return unreadable ? undefined : out;
}

// ── MCP server and plugin tools ──────────────────────────────────────────

/** Argument names that, holding a mail address or phone number, name who a message goes to. */
const PERSON_RECIPIENT_KEYS: ReadonlySet<string> = new Set([
  'to', 'cc', 'bcc', 'recipient', 'recipients', 'torecipients', 'ccrecipients', 'bccrecipients', 'attendee', 'attendees', 'invitee', 'invitees',
]);

/** The mail addresses and phone numbers an undeclared tool's arguments name as recipients (top level, and one level down). */
function argumentRecipients(toolName: string, args: Record<string, unknown>): string[] {
  // A tool that only saves a draft sends nothing; the send of the draft is its own call.
  if (/draft/i.test(toolName) && !/send/i.test(toolName)) return [];
  const out: string[] = [];
  const visit = (value: Record<string, unknown>, depth: number) => {
    for (const [key, inner] of Object.entries(value)) {
      if (PERSON_RECIPIENT_KEYS.has(key.toLowerCase())) {
        const found: string[] = [];
        leaves(inner, found);
        for (const entry of found) { const address = addressIn(entry); if (address !== undefined) out.push(address); }
      } else if (depth < 1 && inner && typeof inner === 'object' && !Array.isArray(inner)) {
        visit(inner as Record<string, unknown>, depth + 1);
      }
    }
  };
  visit(args, 0);
  return out;
}

/**
 * What a call no declaration covers sends to, read by these rules: the shell
 * commands it runs (`commands`, read by the caller with the exec tool's own
 * reading), a `fetch` request to a messaging service, or the arguments of an
 * MCP server or plugin tool call that is not a read. `[]` when it sends to no
 * recipient these rules recognise; `undefined` when it is such a send and its
 * recipients cannot be read. `directory` is the call's working directory,
 * where a shell script a command runs is read from.
 */
export function undeclaredSendRecipients(toolName: string, args: Record<string, unknown>,
  definition: Pick<ToolDefinition, 'sideEffects'> | undefined, commands: readonly string[], reads: boolean, directory: string | undefined): SendRecipients {
  const parts: SendRecipients[] = [commandRecipients(commands, directory)];
  if (toolName === 'fetch') parts.push(fetchRecipients(args));
  else if (!reads && toolName === 'mcp' && args['mode'] === 'call' && args['input'] && typeof args['input'] === 'object' && !Array.isArray(args['input'])) {
    const qualified = typeof args['qualifiedName'] === 'string' ? args['qualifiedName'] : '';
    parts.push(argumentRecipients(qualified.slice(qualified.lastIndexOf(':') + 1), args['input'] as Record<string, unknown>));
  } else if (!reads && definition !== undefined && definition.sideEffects === undefined && toolName !== 'mcp') {
    parts.push(argumentRecipients(toolName, args));
  }
  return joined(parts);
}

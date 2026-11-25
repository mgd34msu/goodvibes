/**
 * The API services your stored keys are sent to (`services.json`), managed by
 * the daemon on its own services file, which every program on this machine
 * reads (the terminal app's and the daemon's are one file; the Agent's own
 * was carried into it once). A project's services file is read for the
 * caller's project: an entry from it waits until you use it once. Sending a
 * key with a request stays with whichever program runs the turn (the fetch
 * tool reads the same files).
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { describePendingProjectService, pendingProjectServiceLines, type ServiceRegistry } from '../../config/service-registry.js';
import { summarizeError } from '../../utils/error-display.js';
import { noteListChanged } from '../../runtime/list-changes.js';
import { CapabilityRefusal, REPLACED_DONE, type CapabilityCaller, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';

/** What the services capabilities need: the services files as seen from the caller's project. */
export interface ServicesCapabilityServices {
  readonly apiServices: {
    /** The registry over the daemon's own services file and the services file of the project at `workingDirectory` (as `program` keeps it). */
    forProject(caller: CapabilityCaller): ServiceRegistry;
    /** The folder a relative file path the person gave is read in when the caller names none. */
    readonly workingDirectory: () => string;
  };
}

/** Your services. */
export const SERVICES_LIST = 'services' as ListName;
/** Services from this project's services file that wait for you. */
export const PENDING_SERVICES_LIST = 'services.pending' as ListName;

const SERVICE_AUTH_TYPES = new Set(['bearer', 'basic', 'api-key', 'oauth']);

const SERVICE: InputDescription = { id: 'service', label: 'Service', help: 'Your services', kind: 'choice', choices: { list: SERVICES_LIST }, required: true, typed: { position: 1 } };
const FILE = (help: string): InputDescription => ({ id: 'path', label: 'File', help, kind: 'path', freeTextReason: 'a file path on this machine', required: true, typed: { position: 1 } });
const REPLACE: InputDescription = {
  id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', kind: 'choice',
  choices: [
    { value: 'no', label: 'Keep it and stop', help: 'Nothing is written when the file is there.' },
    { value: 'yes', label: 'Write over it', help: 'What the file holds now is lost.', risk: 'cannot-be-undone', riskDone: REPLACED_DONE },
  ],
  required: { default: 'no', defaultMeans: 'keep it and stop' }, typed: { flag: '--replace', switchOn: 'yes' },
};

/** The registry, refused while its file cannot be read (nothing can be listed or checked then). */
function readable(services: ServicesCapabilityServices, caller: CapabilityCaller): ServiceRegistry {
  const registry = services.apiServices.forProject(caller);
  const unreadable = registry.unreadableReason();
  if (unreadable) throw new CapabilityRefusal(`Your services file cannot be used: ${unreadable}.`, 'Fix or remove the file, or replace your services list from a file; services cannot be listed or checked until then.', 'SERVICES_UNREADABLE');
  return registry;
}

function filePath(services: ServicesCapabilityServices, caller: CapabilityCaller, path: string): string {
  return resolve(caller.workingDirectory ?? services.apiServices.workingDirectory(), path);
}

/** Why `parsed` cannot be a services.json: a name-to-service object whose entries each name an auth type and a token key. */
function servicesFileProblems(parsed: unknown): string[] {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ['expected an object keyed by service name'];
  const problems: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    const service = value as { authType?: unknown; tokenKey?: unknown } | null;
    if (typeof service !== 'object' || service === null) problems.push(`"${name}" is not an object`);
    else if (typeof service.authType !== 'string' || !SERVICE_AUTH_TYPES.has(service.authType)) problems.push(`"${name}" has no valid authType`);
    else if (typeof service.tokenKey !== 'string') problems.push(`"${name}" has no tokenKey`);
  }
  return problems;
}

interface ImportedService {
  readonly authType: string;
  readonly tokenKey: string;
  readonly baseUrl?: unknown;
}

function hostOf(baseUrl: unknown): string {
  if (typeof baseUrl !== 'string' || !baseUrl) return '(no address)';
  try { return new URL(baseUrl).host || baseUrl; } catch { return baseUrl; }
}

/** What an import changes: every service that is new or whose address, sign-in type or key differs, then the ones no longer listed. */
function importChangeLines(current: Readonly<Record<string, { readonly authType: string; readonly tokenKey: string; readonly baseUrl?: string | undefined }>>, incoming: Readonly<Record<string, ImportedService>>): string[] {
  const changed = Object.entries(incoming).filter(([name, next]) => {
    const was = current[name];
    return !was || was.authType !== next.authType || was.tokenKey !== next.tokenKey || (was.baseUrl ?? '') !== (typeof next.baseUrl === 'string' ? next.baseUrl : '');
  }).map(([name, next]) => `  ${name}: ${next.tokenKey} -> ${hostOf(next.baseUrl)} (${next.authType}${current[name] ? ', changed' : ', new'})`);
  const removed = Object.keys(current).filter((name) => !(name in incoming));
  return [
    changed.length > 0 ? 'New or changed services (the key each sends -> where):' : 'No service is new or changed.',
    ...changed,
    `No longer listed: ${removed.join(', ') || 'none'}`,
  ];
}

/** Each service with what it is missing to work, as rows a list or a script reads. */
async function serviceRows(registry: ServiceRegistry) {
  const all = registry.getAll();
  const names = Object.keys(all).sort((a, b) => a.localeCompare(b));
  const rows = await Promise.all(names.map(async (name) => {
    const inspection = await registry.inspect(name);
    const config = all[name]!;
    const missing: string[] = [];
    if (inspection?.storeUnreadable) missing.push(inspection.storeUnreadable);
    else if (inspection) {
      if (!inspection.hasPrimaryCredential) missing.push('its key is not stored');
      if (config.authType === 'basic' && !inspection.hasPasswordCredential) missing.push('its password is not stored');
    }
    if (!config.baseUrl) missing.push('it has no address');
    return {
      name, authType: config.authType, ...(config.baseUrl ? { address: config.baseUrl } : {}), keyName: config.tokenKey,
      state: inspection?.storeUnreadable ? 'unreadable' : missing.length > 0 ? 'missing' : 'ready', missing,
    };
  }));
  return rows;
}

export const SERVICES_LIST_CAPABILITY: CapabilityDefinition<ServicesCapabilityServices> = {
  capability: { id: 'services.list', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'see-services', label: 'See your API services', word: 'list', inputs: [],
  sentence: 'Shows each API service your keys go to, how it signs in and where it is, and any service from this project that waits for you.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const registry = services.apiServices.forProject(caller);
    const unreadable = registry.unreadableReason();
    const pending = registry.pendingProjectServices().map((entry) => ({ name: entry.name, path: entry.path, sends: describePendingProjectService(entry), digest: entry.digest }));
    if (unreadable) {
      return { text: `Your services file cannot be used: ${unreadable}.`, data: { services: [], pending, unreadable, file: registry.userServicesFilePath } };
    }
    const rows = await serviceRows(registry);
    return {
      text: [
        rows.length === 0 ? `No services yet. Add entries to ${registry.userServicesFilePath || 'your services file'}, or replace your services list from a file.` : 'Services:',
        ...rows.map((row) => `  ${row.name.padEnd(20)} ${row.authType.padEnd(10)} ${row.address ?? '(no address)'}${row.missing.length > 0 ? `  (${row.missing.join('; ')})` : ''}`),
        ...pendingProjectServiceLines(registry.pendingProjectServices()),
      ].join('\n'),
      data: { services: rows, pending, file: registry.userServicesFilePath },
    };
  },
};

export const SERVICES_SHOW: CapabilityDefinition<ServicesCapabilityServices> = {
  capability: { id: 'services.show', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'see-service', label: 'See one service', word: 'show', inputs: [SERVICE],
  sentence: 'Shows how {service} signs in, its address, and which of its credentials are stored.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { service: 'github' },
  async run(values, services, caller) {
    const registry = readable(services, caller);
    const name = values.service!.trim();
    const inspection = await registry.inspect(name);
    if (!inspection) {
      const waiting = registry.pendingProjectServices().find((service) => service.name === name);
      if (waiting) throw new CapabilityRefusal(`${name} comes from this project's services file and waits for you; it is not used: ${describePendingProjectService(waiting)}.`, `Use it from the Services list in Models and providers.`);
      throw new CapabilityRefusal(`No service is named ${name}.`, 'The Services list in Models and providers shows them.', 'NOT_FOUND');
    }
    const has = (value: boolean) => (value ? 'stored' : inspection.storeUnreadable ? 'could not be read' : 'not stored');
    return {
      text: [
        name,
        ...(inspection.storeUnreadable ? [`  ${inspection.storeUnreadable}`] : []),
        `  signs in with: ${inspection.config.authType}`,
        `  address: ${inspection.config.baseUrl ?? '(none)'}`,
        `  key: ${has(inspection.hasPrimaryCredential)}`,
        `  password: ${has(inspection.hasPasswordCredential)}`,
        `  webhook address: ${has(inspection.hasWebhookUrl)}`,
        `  signing secret: ${has(inspection.hasSigningSecret)}`,
        `  public key: ${has(inspection.hasPublicKey)}`,
        `  app token: ${has(inspection.hasAppToken)}`,
      ].join('\n'),
      data: { service: name, authType: inspection.config.authType, key: has(inspection.hasPrimaryCredential) },
    };
  },
};

export const SERVICES_CHECK: CapabilityDefinition<ServicesCapabilityServices> = {
  capability: { id: 'services.check', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'check-all', label: 'Check every service', word: 'check', inputs: [],
  sentence: 'Checks each service for a missing key, password or address, and counts them by how they sign in.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services, caller) {
    const rows = await serviceRows(readable(services, caller));
    const byAuth = new Map<string, number>();
    for (const row of rows) byAuth.set(row.authType, (byAuth.get(row.authType) ?? 0) + 1);
    const problems = rows.flatMap((row) => row.missing.map((missing) => `${row.name}: ${missing}`));
    return {
      text: [
        `${rows.length} service${rows.length === 1 ? '' : 's'}${byAuth.size > 0 ? ` (${[...byAuth].map(([auth, n]) => `${n} ${auth}`).join(', ')})` : ''}.`,
        ...(problems.length > 0 ? problems.map((problem) => `  ${problem}`) : ['Each one has what it needs to sign in.']),
      ].join('\n'),
      data: { count: rows.length, problems },
    };
  },
};

export const SERVICES_TEST: CapabilityDefinition<ServicesCapabilityServices> = {
  capability: { id: 'services.test', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'test', label: 'Test a service\'s connection', word: 'test', inputs: [SERVICE],
  sentence: 'Sends one request to {service} with its stored credentials and shows how it answered.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'none', example: { service: 'github' },
  async run(values, services, caller) {
    const name = values.service!.trim();
    const result = await readable(services, caller).testConnection(name);
    return {
      text: [
        `${name}: ${result.ok ? 'it answered' : 'it did not work'} (${result.outcome})`,
        `  status: ${result.status ?? 'none'}`,
        `  address tried: ${result.testedUrl ?? 'none'}`,
        ...(result.error ? [`  problem: ${result.error}`] : []),
      ].join('\n'),
      data: { service: name, ok: result.ok, outcome: result.outcome, status: result.status },
    };
  },
};

export const SERVICES_CHECK_AUTH: CapabilityDefinition<ServicesCapabilityServices> = {
  capability: { id: 'services.check-auth', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'check-sign-in', label: 'Check that a service can sign in', word: 'check-auth', inputs: [SERVICE],
  sentence: 'Checks that {service}\'s stored credentials make its sign-in headers now, and names the headers without their values.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { service: 'github' },
  async run(values, services, caller) {
    const registry = readable(services, caller);
    const name = values.service!.trim();
    const headers = await registry.resolveAuth(name);
    const unreadable = headers ? undefined : (await registry.inspect(name))?.storeUnreadable;
    if (unreadable) throw new CapabilityRefusal(`${name} cannot sign in right now: ${unreadable}`);
    if (!headers) throw new CapabilityRefusal(`${name} cannot sign in right now: a credential it needs is not stored.`, `See ${name} in the Services list of Models and providers for which.`);
    return { text: [`${name} signs in with these headers (values not shown):`, ...Object.keys(headers).map((key) => `  ${key}`)].join('\n'), data: { service: name, headers: Object.keys(headers) } };
  },
};

export const SERVICES_TRUST: CapabilityDefinition<ServicesCapabilityServices> = {
  capability: { id: 'services.trust', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'trust', label: 'Use a service this project defines', word: 'trust',
  inputs: [{ id: 'service', label: 'Service', help: 'Services from this project\'s services file that wait for you', kind: 'choice', choices: { list: PENDING_SERVICES_LIST }, required: true, typed: { position: 1 } }],
  sentence: '{service} from this project\'s services file is used, sending the stored key it names to the address it names, {lasts}; this loosens a protection, and only that entry, as it reads now, is approved.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'loosens-a-protection',
  ownerOnly: { reason: 'whoever wrote the repository chose which of your stored keys it sends and where', instead: 'Ask the owner to use it from Models and providers.' },
  example: { service: 'acme-api' },
  async run(values, services, caller) {
    const registry = services.apiServices.forProject(caller);
    const name = values.service!.trim();
    const pending = registry.pendingProjectServices().find((service) => service.name === name);
    if (!pending) {
      throw new CapabilityRefusal(`No service from this project's services file named ${name} waits for you; nothing was confirmed.`, pendingProjectServiceLines(registry.pendingProjectServices()).join('\n') || 'The Services list in Models and providers shows your services.', 'NOT_FOUND');
    }
    let result;
    try {
      // What the person was shown (the entry as it reads now) is what is approved.
      result = registry.confirmProjectService(name, pending.digest);
    } catch (error) {
      throw new CapabilityRefusal(`Nothing was confirmed: the confirmation could not be saved (${summarizeError(error)}).`);
    }
    if (!result.ok) throw new CapabilityRefusal(`Nothing was confirmed: ${result.reason}.`, 'Use it again from the Services list to approve it as it reads now.', 'TARGET_CHANGED');
    noteListChanged({ list: 'services', change: 'changed', id: name });
    return { text: `${name} from this project is used from now on: ${describePendingProjectService(result.service)}.`, data: { service: name } };
  },
};

export const SERVICES_EXPORT: CapabilityDefinition<ServicesCapabilityServices> = {
  capability: { id: 'services.export', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'save', label: 'Save your services list to a file', word: 'export', inputs: [FILE('Where to write it, such as services.json'), REPLACE],
  sentence: 'Your services list (names, addresses and the names of their keys, never the keys) is written to {path}.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'services.json' },
  async run(values, services, caller) {
    const all = readable(services, caller).getAll();
    const target = filePath(services, caller, values.path!);
    if (existsSync(target) && values.replace !== 'yes') throw new CapabilityRefusal(`${target} already exists; nothing was written.`, 'Choose "Write over it" to replace it.');
    atomicWriteFileSync(target, `${JSON.stringify(all, null, 2)}\n`, { mkdirp: true });
    return { text: `Wrote ${Object.keys(all).length} service${Object.keys(all).length === 1 ? '' : 's'} to ${target}.`, data: { path: target, count: Object.keys(all).length } };
  },
};

export const SERVICES_IMPORT: CapabilityDefinition<ServicesCapabilityServices> = {
  capability: { id: 'services.import', group: 'models', home: 'daemon', repeat: 'safe' },
  actionId: 'replace', label: 'Replace your services list from a file', word: 'import', inputs: [FILE('A services list, such as one saved from another machine')],
  sentence: 'Your services list is replaced by the one in {path}, for every program, until you change it; every new or changed service is listed with the stored key it sends and its host, and the old list is kept beside it as a .bak file that puts it back.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'loosens-a-protection',
  // The new list may add services or take them away: the line names what it let send, listed above.
  riskDone: 'Each new or changed service listed above may now send the stored key it names to its host; none listed means none was added.',
  ownerOnly: { reason: 'the list names which of your stored keys each service sends and to which host', instead: 'Ask the owner to replace it from Models and providers.' },
  example: { path: 'services.json' },
  async run(values, services, caller) {
    const registry = services.apiServices.forProject(caller);
    const source = filePath(services, caller, values.path!);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(source, 'utf-8')) as unknown;
    } catch (error) {
      throw new CapabilityRefusal(`${source} could not be read: ${summarizeError(error)}. Nothing was changed.`);
    }
    const problems = servicesFileProblems(parsed);
    if (problems.length > 0) throw new CapabilityRefusal(`${source} is not a services list (${problems.slice(0, 3).join('; ')}). Nothing was changed.`);
    const current = registry.unreadableReason() ? {} : registry.getAll();
    const before = Object.keys(current);
    const incomingServices = parsed as Record<string, ImportedService>;
    const incoming = Object.keys(incomingServices);
    const changeLines = importChangeLines(current, incomingServices);
    const target = registry.userServicesFilePath;
    if (!target) throw new CapabilityRefusal('There is no services file of your own here to replace; nothing was changed.');
    let backup: string | undefined;
    if (existsSync(target)) {
      backup = `${target}.bak`;
      copyFileSync(target, backup);
    }
    atomicWriteFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, { mkdirp: true });
    noteListChanged({ list: 'services', change: 'changed' });
    return {
      text: [
        `Your services list is now the ${incoming.length} service${incoming.length === 1 ? '' : 's'} in ${source}.`,
        `  replaced: ${incoming.filter((name) => before.includes(name)).join(', ') || 'none'}`,
        `  no longer listed: ${before.filter((name) => !incoming.includes(name)).join(', ') || 'none'}`,
        ...changeLines.map((line) => `  ${line}`),
        backup ? `To put it back: the old list is kept at ${backup}; replacing the list from that file brings it back.` : '  there was no list before',
      ].join('\n'),
      data: { path: target, ...(backup ? { backup } : {}), services: incoming },
    };
  },
};

/** Every services capability the daemon runs, with the command each answered to as a slash command. */
export const SERVICES_CAPABILITIES: readonly { readonly definition: CapabilityDefinition<ServicesCapabilityServices>; readonly command: { readonly name: string; readonly title: string } }[] = [
  SERVICES_LIST_CAPABILITY, SERVICES_SHOW, SERVICES_CHECK, SERVICES_TEST, SERVICES_CHECK_AUTH, SERVICES_TRUST, SERVICES_EXPORT, SERVICES_IMPORT,
].map((definition) => ({ definition, command: { name: 'services', title: 'Services' } }));

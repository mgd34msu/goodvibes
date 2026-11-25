/**
 * `/services`, described once (command-actions/) for both terminal apps: the
 * API services your stored keys are sent to, checking them, using one that a
 * project's services file defines, and moving the services list in and out of
 * a file. Each app says how it reaches its service registry and its paths.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import {
  atomicWriteFileSync,
  describePendingProjectService,
  pendingProjectServiceLines,
  projectServiceRef,
  type ServiceRegistry,
} from '@goodvibes/engine/platform/platform/config';
import { compareTarget } from '@goodvibes/engine/platform/platform/utils/target-ref';
import type { ShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { commandRefusal, describeTargetChanges, refuseModelWriteOutsideWorkingDirectory } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, CommandDescription, InputDescription } from './command-actions/types.js';
import { REPLACE_FILE_INPUT, doAction, listInput, readAction, textInput } from './described-command-kit.js';

export interface ServicesCommandContext extends CommandActionContext {
  readonly openModal?: ((name: string) => void) | undefined;
}

/** How one app reaches its services. */
export interface ServicesCommandServices<Ctx extends ServicesCommandContext> {
  readonly requireServiceRegistry: (ctx: Ctx) => ServiceRegistry;
  readonly requireShellPaths: (ctx: Ctx) => ShellPathService;
}

let installed: ServicesCommandServices<ServicesCommandContext> | undefined;
function host(): ServicesCommandServices<ServicesCommandContext> {
  if (!installed) throw commandRefusal('Services are not available in this session.');
  return installed;
}

type PendingProjectService = ReturnType<ServiceRegistry['pendingProjectServices']>[number];

const SERVICE_AUTH_TYPES = new Set(['bearer', 'basic', 'api-key', 'oauth']);
const TERMINAL_ONLY = 'Services are read from the services files of the terminal app on this machine.';

/** The registry, refused while its file cannot be read (nothing can be listed or checked then). */
function readable(ctx: ServicesCommandContext): ServiceRegistry {
  const registry = host().requireServiceRegistry(ctx);
  const unreadable = registry.unreadableReason?.() ?? null;
  if (unreadable) throw commandRefusal(`Your services file cannot be used: ${unreadable}.`, 'Fix or remove the file (or replace it: /services import <file>); services cannot be listed or checked until then.');
  return registry;
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

/** The fields of an imported entry the import question shows; servicesFileProblems has checked authType and tokenKey. */
interface ImportedService {
  readonly authType: string;
  readonly tokenKey: string;
  readonly baseUrl?: unknown;
}

function hostOf(baseUrl: unknown): string {
  if (typeof baseUrl !== 'string' || !baseUrl) return '(no address)';
  try { return new URL(baseUrl).host || baseUrl; } catch { return baseUrl; }
}

/**
 * What an import changes, as the owner is asked about it: every service that is
 * new, or whose address, sign-in type or key differs, as `name: key -> host`,
 * then the services no longer listed.
 */
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

const SERVICES = defineList<ServicesCommandContext>({
  name: 'services',
  async read(ctx) {
    const all = readable(ctx).getAll();
    return Object.keys(all).sort((a, b) => a.localeCompare(b)).map((name): ListRow => ({ value: name, label: all[name]?.name ?? name, detail: `${all[name]?.authType ?? ''}  ${all[name]?.baseUrl ?? '(no address)'}` }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});

const PENDING = defineList<ServicesCommandContext>({
  name: 'services.pending',
  async read(ctx) {
    return host().requireServiceRegistry(ctx).pendingProjectServices().map((pending): ListRow => ({ value: pending.name, label: pending.name, detail: describePendingProjectService(pending) }));
  },
  operator: { terminalOnly: TERMINAL_ONLY },
});

const SERVICE: InputDescription = listInput({ id: 'service', label: 'Service', help: 'Your services', list: SERVICES });
const FILE = (help: string): InputDescription => textInput({ id: 'path', label: 'File', help, why: 'a file path on this machine', kind: 'path', typed: { position: 1 } });

/** Each service missing something it needs to work, in words. */
async function serviceProblems(registry: ServiceRegistry): Promise<{ readonly count: number; readonly byAuth: Map<string, number>; readonly problems: string[] }> {
  const names = Object.keys(registry.getAll());
  const inspections = (await Promise.all(names.map((name) => registry.inspect(name)))).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const byAuth = new Map<string, number>();
  const problems: string[] = [];
  for (const inspection of inspections) {
    const { name, authType, baseUrl } = inspection.config;
    byAuth.set(authType, (byAuth.get(authType) ?? 0) + 1);
    // A secret store this computer could not read is said as such: its credentials are not asked for again.
    if (inspection.storeUnreadable) problems.push(`${name}: ${inspection.storeUnreadable}`);
    else {
      if (!inspection.hasPrimaryCredential) problems.push(`${name}: its key is not stored`);
      if (authType === 'basic' && !inspection.hasPasswordCredential) problems.push(`${name}: its password is not stored`);
    }
    if (!baseUrl) problems.push(`${name}: it has no address`);
  }
  return { count: names.length, byAuth, problems };
}

export const SERVICES_COMMAND: CommandDescription<ServicesCommandContext> = {
  name: 'services',
  title: 'Services',
  summary: 'The API services your stored keys are sent to: see and check them, and use one a project defines',
  group: 'Setup',
  report: 'see-services',
  firstScreenRows: ['see-services', 'see-service', 'check-all', 'test', 'check-sign-in', 'trust', { label: 'Move your services list…', actions: ['save', 'replace'] }, 'open'],
  actions: [
    readAction<ServicesCommandContext>({
      id: 'see-services', label: 'See your services', word: 'list',
      sentence: 'Shows each service, how it signs in and where it is, and any service from this project that waits for you.',
      operator: { terminalOnly: TERMINAL_ONLY },
      async rowValue(ctx) {
        const registry = host().requireServiceRegistry(ctx);
        const count = Object.keys(registry.getAll()).length;
        const waiting = registry.pendingProjectServices().length;
        return `${count === 0 ? 'none yet' : `${count} service${count === 1 ? '' : 's'}`}${waiting > 0 ? `, ${waiting} waiting for you` : ''}`;
      },
      async run(_values, ctx) {
        const registry = readable(ctx);
        const all = registry.getAll();
        const names = Object.keys(all).sort((a, b) => a.localeCompare(b));
        return [
          names.length === 0 ? `No services yet. Add entries to ${registry.userServicesFilePath || 'your services file'}, or load a list: /services import <file>.` : 'Services:',
          ...names.map((name) => `  ${name.padEnd(20)} ${(all[name]?.authType ?? '').padEnd(10)} ${all[name]?.baseUrl ?? '(no address)'}`),
          ...pendingProjectServiceLines(registry.pendingProjectServices()),
        ].join('\n');
      },
    }),
    readAction<ServicesCommandContext>({
      id: 'see-service', label: 'See one service', word: 'show', inputs: [SERVICE],
      sentence: 'Shows how {service} signs in, its address, and which of its credentials are stored.',
      operator: { terminalOnly: TERMINAL_ONLY },
      example: { service: 'github' },
      async run(values, ctx) {
        const registry = readable(ctx);
        const name = values.service!;
        const inspection = await registry.inspect(name);
        if (!inspection) {
          const waiting = registry.pendingProjectServices().find((service) => service.name === name);
          if (waiting) throw commandRefusal(`${name} comes from this project's services file and waits for you; it is not used: ${describePendingProjectService(waiting)}.`, `/services trust ${name} uses it.`);
          throw commandRefusal(`No service is named ${name}.`, '/services list shows them.');
        }
        const has = (value: boolean) => (value ? 'stored' : inspection.storeUnreadable ? 'could not be read' : 'not stored');
        return [
          `${name}`,
          ...(inspection.storeUnreadable ? [`  ${inspection.storeUnreadable}`] : []),
          `  signs in with: ${inspection.config.authType}`,
          `  address: ${inspection.config.baseUrl ?? '(none)'}`,
          `  key: ${has(inspection.hasPrimaryCredential)}`,
          `  password: ${has(inspection.hasPasswordCredential)}`,
          `  webhook address: ${has(inspection.hasWebhookUrl)}`,
          `  signing secret: ${has(inspection.hasSigningSecret)}`,
          `  public key: ${has(inspection.hasPublicKey)}`,
          `  app token: ${has(inspection.hasAppToken)}`,
        ].join('\n');
      },
    }),
    readAction<ServicesCommandContext>({
      id: 'check-all', label: 'Check every service', word: 'check',
      sentence: 'Checks each service for a missing key, password or address, and counts them by how they sign in.',
      operator: { terminalOnly: TERMINAL_ONLY },
      async run(_values, ctx) {
        const { count, byAuth, problems } = await serviceProblems(readable(ctx));
        return [
          `${count} service${count === 1 ? '' : 's'}${byAuth.size > 0 ? ` (${[...byAuth].map(([auth, n]) => `${n} ${auth}`).join(', ')})` : ''}.`,
          ...(problems.length > 0 ? problems.map((problem) => `  ${problem}`) : ['Each one has what it needs to sign in.']),
        ].join('\n');
      },
    }),
    doAction<ServicesCommandContext>({
      id: 'test', label: 'Test a service\'s connection', word: 'test', inputs: [SERVICE], touches: 'another-machine',
      sentence: 'Sends one request to {service} with its stored credentials and shows how it answered.',
      operator: { terminalOnly: TERMINAL_ONLY },
      example: { service: 'github' },
      async run(values, ctx) {
        const result = await readable(ctx).testConnection(values.service!);
        return [
          `${values.service}: ${result.ok ? 'it answered' : 'it did not work'} (${result.outcome})`,
          `  status: ${result.status ?? 'none'}`,
          `  address tried: ${result.testedUrl ?? 'none'}`,
          ...(result.error ? [`  problem: ${result.error}`] : []),
        ].join('\n');
      },
    }),
    readAction<ServicesCommandContext>({
      id: 'check-sign-in', label: 'Check that a service can sign in', word: 'check-auth', inputs: [SERVICE],
      sentence: 'Checks that {service}\'s stored credentials make its sign-in headers now, and names the headers without their values.',
      operator: { terminalOnly: TERMINAL_ONLY },
      example: { service: 'github' },
      async run(values, ctx) {
        const registry = readable(ctx);
        const headers = await registry.resolveAuth(values.service!);
        const unreadable = headers ? undefined : (await registry.inspect(values.service!))?.storeUnreadable;
        if (unreadable) throw commandRefusal(`${values.service} cannot sign in right now: ${unreadable}`);
        if (!headers) throw commandRefusal(`${values.service} cannot sign in right now: a credential it needs is not stored.`, `/services show ${values.service} shows which.`);
        return [`${values.service} signs in with these headers (values not shown):`, ...Object.keys(headers).map((key) => `  ${key}`)].join('\n');
      },
    }),
    {
      id: 'trust', label: 'Use a service this project defines', word: 'trust',
      inputs: [listInput({ id: 'service', label: 'Service', help: 'Services from this project\'s services file that wait for you', list: PENDING })],
      sentence: '{service} from this project\'s services file is used, sending the stored key it names to the address it names, {lasts}; this loosens a protection, so you are asked with exactly what it sends and where, and only that entry is approved.', done: '',
      // It asks its own question, with the entry's facts, and approves exactly that entry (by digest).
      touches: 'credential', lasts: 'kept', risk: 'loosens-a-protection', asksItself: true,
      ownerOnly: { reason: 'whoever wrote the repository chose which of your stored keys it sends and where', instead: 'Ask the owner to run /services trust <service>.' },
      operator: { terminalOnly: TERMINAL_ONLY },
      example: { service: 'acme-api' },
      async run(values, ctx) {
        const registry = host().requireServiceRegistry(ctx);
        const name = values.service!;
        const read = () => registry.pendingProjectServices().find((service) => service.name === name);
        const shownFirst = read();
        if (!shownFirst) throw commandRefusal(`No service from this project's services file named ${name} waits for you; nothing was confirmed.`, pendingProjectServiceLines(registry.pendingProjectServices()).join('\n') || '/services list shows your services.');
        const detail = (pending: PendingProjectService) => `${describePendingProjectService(pending)}.\nA project's services file is part of the checkout, so whoever wrote the repository chose which of your stored keys ${name} sends and to which host. Once confirmed, ${name} is used as shown here; if the repository changes its keys, header or host it waits for confirmation again. This loosens a protection.`;
        const confirm = ctx.confirm;
        if (!confirm || ctx.invokedByModel === true) {
          throw commandRefusal(`${name} was not confirmed: it is confirmed only where you can be asked with what it sends.\n${detail(shownFirst)}`, 'Type /services trust in the terminal app.', 'CONFIRMATION_REQUIRED');
        }
        const ask = (body: string) => confirm({ title: `Use the service ${name} from this project's services file?`, body, confirmLabel: 'Use it', cancelLabel: 'Back', tone: 'danger' });
        if (!(await ask(detail(shownFirst)))) throw commandRefusal('Not confirmed: nothing was changed.', undefined, 'CANCELLED');
        // What was shown is what is approved: a change since then is shown and asked about again (once).
        let shown = shownFirst;
        const now = read();
        const changes = compareTarget(projectServiceRef(shown), now ? projectServiceRef(now) : null);
        if (changes.length > 0) {
          if (!now) throw commandRefusal(`${describeTargetChanges(changes)}\nNothing was confirmed.`, undefined, 'TARGET_CHANGED');
          if (!(await ask(`${describeTargetChanges(changes)}\n\n${detail(now)}`))) throw commandRefusal('Not confirmed: nothing was changed.', undefined, 'CANCELLED');
          shown = now;
        }
        let result;
        try {
          result = registry.confirmProjectService(name, shown.digest);
        } catch (error) {
          throw commandRefusal(`Nothing was confirmed: the confirmation could not be saved (${summarizeError(error)}).`);
        }
        // A second change after the second question is refused by the digest check: nothing unshown is approved.
        if (!result.ok) throw commandRefusal(`Nothing was confirmed: ${result.reason}.`, `/services trust ${name} asks again.`, 'TARGET_CHANGED');
        return `${name} from this project is used from now on: ${describePendingProjectService(result.service)}.`;
      },
    },
    doAction<ServicesCommandContext>({
      id: 'save', label: 'Save your services list to a file', word: 'export', inputs: [FILE('Where to write it, such as services.json'), REPLACE_FILE_INPUT],
      sentence: 'Your services list (names, addresses and the names of their keys, never the keys) is written to {path}.',
      operator: { terminalOnly: TERMINAL_ONLY },
      example: { path: 'services.json' },
      async run(values, ctx) {
        const all = readable(ctx).getAll();
        const paths = host().requireShellPaths(ctx);
        const target = paths.resolveWorkspacePath(values.path!);
        refuseModelWriteOutsideWorkingDirectory(ctx, paths.workingDirectory, target);
        if (existsSync(target) && values.replace !== 'yes') throw commandRefusal(`${target} already exists; nothing was written.`, `Write over it: /services export ${values.path} --replace`);
        atomicWriteFileSync(target, `${JSON.stringify(all, null, 2)}\n`, { mkdirp: true });
        return `Wrote ${Object.keys(all).length} service${Object.keys(all).length === 1 ? '' : 's'} to ${target}.`;
      },
    }),
    {
      id: 'replace', label: 'Replace your services list from a file', word: 'import', inputs: [FILE('A services list, such as one /services export wrote')],
      sentence: 'Your services list is replaced by the one in {path}, until you change it; every new or changed service is listed with the stored key it sends and its host, and the old list is kept beside it as a .bak file that puts it back.', done: '',
      touches: 'credential', lasts: 'kept', risk: 'loosens-a-protection',
      ownerOnly: { reason: 'the list names which of your stored keys each service sends and to which host', instead: 'Ask the owner to run /services import <file>.' },
      operator: { terminalOnly: TERMINAL_ONLY },
      example: { path: 'services.json' },
      async run(values, ctx) {
        const registry = host().requireServiceRegistry(ctx);
        const source = host().requireShellPaths(ctx).resolveWorkspacePath(values.path!);
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(source, 'utf-8')) as unknown;
        } catch (error) {
          throw commandRefusal(`${source} could not be read: ${summarizeError(error)}. Nothing was changed.`);
        }
        const problems = servicesFileProblems(parsed);
        if (problems.length > 0) throw commandRefusal(`${source} is not a services list (${problems.slice(0, 3).join('; ')}). Nothing was changed.`);
        const current = registry.unreadableReason?.() ? {} : registry.getAll();
        const before = Object.keys(current);
        const incomingServices = parsed as Record<string, ImportedService>;
        const incoming = Object.keys(incomingServices);
        const changeLines = importChangeLines(current, incomingServices);
        // Only the owner's own line replaces it (owner-only): it is the request, so it runs at once, says what
        // changed, and keeps the old list beside it, which puts it back.
        if (ctx.invokedByModel === true) {
          throw commandRefusal(`Your services list was not replaced: only you can replace it.\n${changeLines.join('\n')}`, 'Type /services import in the terminal app.', 'OWNER_ONLY_COMMAND');
        }
        const target = registry.userServicesFilePath;
        let backup: string | undefined;
        if (existsSync(target)) {
          backup = `${target}.bak`;
          copyFileSync(target, backup);
        }
        atomicWriteFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, { mkdirp: true });
        return [
          `Your services list is now the ${incoming.length} service${incoming.length === 1 ? '' : 's'} in ${source}.`,
          `  replaced: ${incoming.filter((name) => before.includes(name)).join(', ') || 'none'}`,
          `  no longer listed: ${before.filter((name) => !incoming.includes(name)).join(', ') || 'none'}`,
          ...changeLines.map((line) => `  ${line}`),
          backup ? `To put it back: the old list is kept at ${backup}; /services import ${backup} brings it back.` : '  there was no list before',
        ].join('\n');
      },
    },
    readAction<ServicesCommandContext>({
      id: 'open', label: 'Open the services screen', word: 'open',
      sentence: 'Opens the screen that lists your services, where one can be tested.',
      operator: { terminalOnly: 'It is a terminal screen.' },
      async run(_values, ctx) {
        if (!ctx.openModal) throw commandRefusal('This app has no services screen.', '/services list shows your services.');
        ctx.openModal('services-modal');
      },
    }),
  ],
};

const SERVICES_SLASH_COMMAND = defineCommand(SERVICES_COMMAND);

/** Register `/services` (the one description) with how this app reaches its services. */
export function registerServicesCommand<Ctx extends ServicesCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, services: ServicesCommandServices<Ctx>): void {
  installed = services as unknown as ServicesCommandServices<ServicesCommandContext>;
  registry.register(SERVICES_SLASH_COMMAND);
}

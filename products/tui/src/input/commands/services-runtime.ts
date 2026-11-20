import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteFileSync } from '@goodvibes-jev/engine/platform/platform/config';
import type { CommandRegistry } from '../command-registry.ts';
import type { SelectionAction, SelectionItem } from '../selection-modal.ts';
import { requireServiceRegistry, requireShellPaths } from './runtime-services.ts';
import { describePendingProjectService, pendingProjectServiceLines, projectServiceRef, type ServiceRegistry } from '@goodvibes-jev/engine/platform/platform/config';
import { assertTarget, TargetChangedError, type TargetRef } from '@goodvibes-jev/engine/platform/platform/utils/target-ref';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';

const SERVICE_AUTH_TYPES = new Set(['bearer', 'basic', 'api-key', 'oauth']);

function pendingServiceLines(registry: ServiceRegistry): string[] {
  return pendingProjectServiceLines(registry.pendingProjectServices());
}

/** Why `parsed` cannot be a services.json: a name-to-service object whose entries each name an auth type and a token key. */
function servicesImportProblems(parsed: unknown): string[] {
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

export function registerServicesRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'services',
    aliases: ['svc'],
    description: 'Manage API service configurations',
    usage: '[open|list|inspect <name>|test <name>|resolve|auth <name>|auth-review|doctor|trust <name>|export <path>|import <path>]',
    confirm: (args, ctx) => {
      if (args[0] !== 'trust' || !args[1]) return undefined;
      // The question names what the entry sends and where; the yes approves that entry only.
      const pending = requireServiceRegistry(ctx).pendingProjectServices().find((service) => service.name === args[1]);
      if (!pending) return undefined; // The handler says why there is nothing to confirm.
      return {
        title: `Use the service ${args[1]} from this project's services file?`,
        detail: `${describePendingProjectService(pending)}.\nA project's services file is part of the checkout, so whoever wrote the repository chose which of your stored keys ${args[1]} sends and to which host. Once confirmed, ${args[1]} is used as shown here; if the repository changes its keys, header or host it waits for confirmation again.`,
        confirmLabel: 'Use it',
        reviewed: projectServiceRef(pending),
      };
    },
    async handler(args, ctx, reviewed?: unknown) {
      const sub = args[0] ?? 'open';
      const shellPaths = requireShellPaths(ctx);
      if (sub === 'open' || sub === 'panel') {
        ctx.openModal?.('services-modal'); // services view -> config modal
        return;
      }
      const svcRegistry = requireServiceRegistry(ctx);
      const all = svcRegistry.getAll();
      const keys = Object.keys(all);
      const unreadable = svcRegistry.unreadableReason?.() ?? null;
      if (unreadable && sub !== 'export' && sub !== 'import') {
        ctx.print(`Service list unusable: ${unreadable}. Fix or remove the file; services cannot be listed or inspected until then.`);
        return;
      }
      if (sub === 'trust') {
        const name = args[1];
        if (!name) {
          ctx.print(['Usage: /services trust <name>', ...pendingServiceLines(svcRegistry)].join('\n'));
          return;
        }
        try {
          // Confirmed: the entry must still be the one shown, and that one is approved.
          const shown = reviewed as TargetRef<'project-service'> | undefined;
          const now = svcRegistry.pendingProjectServices().find((service) => service.name === name);
          if (shown) assertTarget(shown, now ? projectServiceRef(now) : null, `/services trust ${name}`);
          const result = svcRegistry.confirmProjectService(name, shown ? now?.digest : undefined);
          ctx.print(result.ok
            ? `Service ${name} from this project is used from now on: ${describePendingProjectService(result.service)}.`
            : `Nothing was confirmed: ${result.reason}.`);
        } catch (error) {
          if (error instanceof TargetChangedError) throw error;
          ctx.print(`Nothing was confirmed: the confirmation could not be saved (${summarizeError(error)}).`);
        }
        return;
      }
      if (sub === 'inspect') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /services inspect <name>');
          return;
        }
        const inspection = await svcRegistry.inspect(name);
        if (!inspection) {
          const waiting = svcRegistry.pendingProjectServices().find((service) => service.name === name);
          ctx.print(waiting
            ? `Service ${name} waits for your confirmation and is not used: ${describePendingProjectService(waiting)}. /services trust ${name} confirms it.`
            : `Unknown service: ${name}`);
          return;
        }
        ctx.print([
          `Service ${name}`,
          `  authType: ${inspection.config.authType}`,
          `  baseUrl: ${inspection.config.baseUrl ?? '(none)'}`,
          `  primaryCredential: ${inspection.hasPrimaryCredential ? 'present' : 'missing'}`,
          `  passwordCredential: ${inspection.hasPasswordCredential ? 'present' : 'missing'}`,
          `  webhookUrl: ${inspection.hasWebhookUrl ? 'present' : 'missing'}`,
          `  signingSecret: ${inspection.hasSigningSecret ? 'present' : 'missing'}`,
          `  publicKey: ${inspection.hasPublicKey ? 'present' : 'missing'}`,
          `  appToken: ${inspection.hasAppToken ? 'present' : 'missing'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'test') {
        const name = args[1];
        if (!name) {
          ctx.print('Usage: /services test <name>');
          return;
        }
        const result = await svcRegistry.testConnection(name);
        ctx.print([
          `Service test ${name}`,
          `  ok: ${result.ok ? 'yes' : 'no'} (${result.outcome})`,
          `  status: ${result.status ?? 'n/a'}`,
          `  url: ${result.testedUrl ?? 'n/a'}`,
          `  error: ${result.error ?? 'none'}`,
        ].join('\n'));
        return;
      }
      if (sub === 'resolve' || sub === 'auth') {
        // One check, two spellings: whether the service's credential resolves to auth headers now.
        const name = args[1];
        if (!name) {
          ctx.print(`Usage: /services ${sub} <name>`);
          return;
        }
        const headers = await svcRegistry.resolveAuth(name);
        if (!headers) {
          ctx.print(`Service ${name} has no resolvable auth headers right now. /services inspect ${name} shows which credential is missing.`);
          return;
        }
        ctx.print([
          `Resolved auth headers for ${name} (values not shown)`,
          ...Object.keys(headers).map((key) => `  ${key}: <redacted>`),
        ].join('\n'));
        return;
      }
      if (sub === 'doctor') {
        const inspections = await Promise.all(keys.map((name) => svcRegistry.inspect(name)));
        const issues = inspections
          .filter((inspection): inspection is NonNullable<typeof inspection> => inspection !== null)
          .flatMap((inspection) => {
            const findings: string[] = [];
            if (!inspection.hasPrimaryCredential) findings.push(`${inspection.config.name}: missing primary credential`);
            if (inspection.config.authType === 'basic' && !inspection.hasPasswordCredential) findings.push(`${inspection.config.name}: missing password credential`);
            if (!inspection.config.baseUrl) findings.push(`${inspection.config.name}: no baseUrl configured`);
            return findings;
          });
        ctx.print([
          'Service Doctor',
          `  configured: ${keys.length}`,
          `  issues: ${issues.length}`,
          ...(issues.length > 0 ? issues.map((issue) => `  ${issue}`) : ['  all configured services passed readiness checks']),
        ].join('\n'));
        return;
      }
      if (sub === 'auth-review') {
        const inspections = await Promise.all(keys.map((name) => svcRegistry.inspect(name)));
        const authCounts = new Map<string, number>();
        const issues = inspections
          .filter((inspection): inspection is NonNullable<typeof inspection> => inspection !== null)
          .flatMap((inspection) => {
            authCounts.set(inspection.config.authType, (authCounts.get(inspection.config.authType) ?? 0) + 1);
            const findings: string[] = [];
            if (!inspection.config.baseUrl) findings.push(`${inspection.config.name}: missing baseUrl`);
            if ((inspection.config.authType === 'bearer' || inspection.config.authType === 'api-key') && !inspection.hasPrimaryCredential) {
              findings.push(`${inspection.config.name}: missing primary credential`);
            }
            if (inspection.config.authType === 'basic' && !inspection.hasPasswordCredential) {
              findings.push(`${inspection.config.name}: missing password credential`);
            }
            return findings;
          });
        ctx.print([
          'Service Auth Review',
          `  configured: ${keys.length}`,
          ...[...authCounts.entries()].map(([authType, count]) => `  ${authType}: ${count}`),
          ...(issues.length > 0 ? ['', ...issues.map((issue) => `  issue: ${issue}`)] : ['', '  all configured services have a complete auth posture']),
        ].join('\n'));
        return;
      }
      if (sub === 'export') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /services export <path>');
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, JSON.stringify(all, null, 2) + '\n', 'utf-8');
        ctx.print(`Exported services config to ${targetPath}`);
        return;
      }
      if (sub === 'import') {
        const pathArg = args[1];
        if (!pathArg) {
          ctx.print('Usage: /services import <path>');
          return;
        }
        const sourcePath = shellPaths.resolveWorkspacePath(pathArg);
        try {
          const parsed: unknown = JSON.parse(readFileSync(sourcePath, 'utf-8'));
          const problems = servicesImportProblems(parsed);
          if (problems.length > 0) {
            ctx.print(`Services import refused: ${sourcePath} is not a services config (${problems.slice(0, 3).join('; ')}). Nothing was changed.`);
            return;
          }
          const incoming = parsed as Record<string, unknown>;
          const targetPath = shellPaths.resolveUserPath('tui', 'services.json');
          let backup: string | undefined;
          if (existsSync(targetPath)) {
            backup = `${targetPath}.bak`;
            copyFileSync(targetPath, backup);
          }
          atomicWriteFileSync(targetPath, JSON.stringify(incoming, null, 2) + '\n', { mkdirp: true });
          const incomingKeys = Object.keys(incoming);
          const replaced = incomingKeys.filter((key) => keys.includes(key));
          const dropped = keys.filter((key) => !incomingKeys.includes(key));
          ctx.print([
            `Imported services config from ${sourcePath}: ${incomingKeys.length} service(s); this replaces the whole services file.`,
            `  replaced: ${replaced.join(', ') || '(none)'}`,
            `  no longer configured: ${dropped.join(', ') || '(none)'}`,
            backup ? `  previous file kept at ${backup}` : '  there was no previous file',
          ].join('\n'));
        } catch (error) {
          ctx.print(`Failed to import services config: ${summarizeError(error)}`);
        }
        return;
      }
      if (ctx.openSelection) {
        const testAction = new Map<string, SelectionAction>([['t', 'select' as const]]);
        const items: SelectionItem[] = keys.length === 0
          ? [{ id: '_empty', label: 'No services configured', detail: '~/.goodvibes/tui/services.json' }]
          : keys.map((key) => ({ id: key, label: all[key].name ?? key, detail: `${all[key].authType}  ${all[key].baseUrl ?? '(no url)'}`, actions: '[Ctrl+T] test' }));
        ctx.openSelection('Services', items, { allowSearch: true, customActions: testAction }, (result) => {
          if (!result || result.item.id === '_empty') return;
          const svc = all[result.item.id];
          if (!svc) return;
          if (result.action === 'select') {
            void svcRegistry.testConnection(result.item.id).then((testResult) => {
              ctx.print([
                `Service test ${result.item.id}`,
                `  ok: ${testResult.ok ? 'yes' : 'no'} (${testResult.outcome})`,
                `  status: ${testResult.status ?? 'n/a'}`,
                `  url: ${testResult.testedUrl ?? 'n/a'}`,
                `  error: ${testResult.error ?? 'none'}`,
              ].join('\n'));
            });
            return;
          }
          ctx.print([
            `Service ${result.item.id}`,
            `  authType: ${svc.authType}`,
            `  baseUrl: ${svc.baseUrl ?? '(none)'}`,
          ].join('\n'));
        });
        return;
      }
      if (keys.length === 0) {
        ctx.print(['[services] No services configured. Add entries to ~/.goodvibes/tui/services.json or /services import <path>', ...pendingServiceLines(svcRegistry)].join('\n'));
        return;
      }
      ctx.print(['Services:', '', ...keys.map((key) => `  ${key.padEnd(20)} ${all[key].authType.padEnd(10)} ${all[key].baseUrl ?? '(no url)'}`), ...pendingServiceLines(svcRegistry)].join('\n'));
    },
  });
}

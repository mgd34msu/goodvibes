import { createSecretsCommand } from '@goodvibes-jev/engine/terminal-shell/secrets-command';
import { createLocalCommandActions } from '@goodvibes-jev/engine/terminal-shell/local-command-actions';
import { handleBookmarks } from '@goodvibes-jev/engine/terminal-shell/bookmark-command';
import 'path';
import 'node:fs';
import 'node:fs/promises';
import type { CommandRegistry, CommandContext, SlashCommand } from '../command-registry.ts';

import '@goodvibes-jev/engine/platform/platform/utils';
import '@goodvibes-jev/engine/platform/platform/config';
import { requireBookmarkManager, requireProviderApi, requireSecretsManager, requireServiceRegistry } from './runtime-services.ts';
import { describePendingProjectService, pendingProjectServiceLines } from '@goodvibes-jev/engine/platform/platform/config';
import {
  credentialWriteScopeWasRelocated,
  resolveCredentialDeleteScope,
  resolveCredentialWriteScope,
} from '../../config/credential-scope.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { commandRefusal, requireYesFlag, stripYesFlag, withOwnerConfirmation, type ConfirmableCommand } from './confirmation.ts';
import { collectAgentMedia, mediaCollectCommand } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { formatAgentMediaGenerationResult, generateAgentMedia } from '@goodvibes-jev/engine/terminal-shell/agent-turn/media-generation';
import { readRefusal } from '@goodvibes-jev/engine/errors';

interface MediaGenerateArgs {
  readonly prompt: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly outputMimeType?: string;
  readonly yes: boolean;
  readonly errors: readonly string[];
}

function readFlagValue(args: readonly string[], index: number, flag: string, errors: string[]): string | null {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    errors.push(`${flag} requires a value.`);
    return null;
  }
  return value;
}

function parseMediaGenerateArgs(args: readonly string[]): MediaGenerateArgs {
  const parsed = stripYesFlag([...args]);
  const errors: string[] = [];
  const promptParts: string[] = [];
  let providerId: string | undefined;
  let modelId: string | undefined;
  let outputMimeType: string | undefined;
  for (let index = 0; index < parsed.rest.length; index += 1) {
    const arg = parsed.rest[index];
    if (arg === '--provider') {
      providerId = readFlagValue(parsed.rest, index, arg, errors) ?? providerId;
      index += 1;
    } else if (arg === '--model') {
      modelId = readFlagValue(parsed.rest, index, arg, errors) ?? modelId;
      index += 1;
    } else if (arg === '--mime') {
      outputMimeType = readFlagValue(parsed.rest, index, arg, errors) ?? outputMimeType;
      index += 1;
    } else if (arg?.startsWith('--')) {
      errors.push(`Unknown media generation flag ${arg}`);
    } else if (arg) {
      promptParts.push(arg);
    }
  }
  const prompt = promptParts.join(' ').trim();
  if (!prompt) errors.push('Media generation prompt is required.');
  return {
    prompt,
    ...(providerId ? { providerId } : {}),
    ...(modelId ? { modelId } : {}),
    ...(outputMimeType ? { outputMimeType } : {}),
    yes: parsed.yes,
    errors,
  };
}

/** `collect <provider> <task-id> [key=value ...]`: the pending job a generation named, as the command printed it. */
function parseMediaCollectArgs(args: readonly string[]): { readonly providerId: string; readonly taskId: string; readonly resume: Record<string, string> } | string {
  const [providerId, taskId, ...pairs] = stripYesFlag([...args]).rest;
  if (!providerId || !taskId) return 'collect needs the provider and task id the pending result named.';
  const resume: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) return `"${pair}" is not key=value; give the resume values exactly as the pending result printed them.`;
    resume[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return { providerId, taskId, resume };
}

const localActions = createLocalCommandActions<CommandContext>(requireProviderApi, {
  hidden: true,
  liveDiscovery: false,
  unpinByModelId: true,
  imageHint: '<path> [prompt]',
  supportedFormats: '\nSupported .png, .jpg, .jpeg, .webp, .gif',
  maximumImageSize: 'Maximum 20MB',
  partialRefresh: 'Some refreshes failed, see messages above.',
  error: (detail) => 'Error\n  message ' + detail,
  imageFailure: (kind, detail) => kind + ' ' + detail,
  invalidBlockType: (type, valid) => 'Unknown type ' + type + '\nValid types ' + valid.join(', '),
  noteTouch: (conversation, key) => conversation.noteUserTouch(key),
});

const secretsCommand = createSecretsCommand<CommandContext>(requireSecretsManager, {
  description: 'Manage hierarchy-aware secrets, external secret refs, and secure/plaintext storage policy controls',
  hidden: true,
  confirmMutations: true,
  concealedEntry: true,
  writeScope: resolveCredentialWriteScope,
  deleteScope: resolveCredentialDeleteScope,
  relocationNote: (key, requested) =>
    credentialWriteScopeWasRelocated(key, requested)
      ? '\n  filed in the daemon tier instead of ' +
        requested +
        ', the daemon is what reads this credential, and it reads only its own tier'
      : '',
  resolved: (ref, status) => '[secrets] ' + ref + '\n  status ' + status,
  failed: (ref, error) => '[secrets] ' + ref + ' failed ' + error,
  deleted: (key) => '[secrets] Deleted\n  key ' + key,
});

/**
 * The services this app sends stored credentials to, and the confirmation a
 * project's services file entry needs before it is used. Confirming is the
 * owner's: a model-run line is always put to the owner.
 */
const servicesCommand = withOwnerConfirmation<CommandContext, SlashCommand & Pick<ConfirmableCommand<CommandContext>, 'confirm'>>({
  name: 'services',
  effect: 'mixed',
  readVerbs: ['list'],
  description: 'List API services and confirm the ones a project\'s services file defines',
  hidden: true,
  usage: '[list|trust <name> --yes]',
  argsHint: '[list|trust] [name]',
  subcommands: { list: '', trust: '<name> --yes' },
  confirm: (args) => args[0] === 'trust' && args[1]
    ? {
        title: `Use the service ${args[1]} from this project's services file?`,
        detail: `A project's services file is part of the checkout, so whoever wrote the repository chose which of your stored keys ${args[1]} sends and to which host. Once confirmed, ${args[1]} is used as it stands now; if the repository changes its keys, header or host it waits for confirmation again.`,
        confirmLabel: 'Use it',
      }
    : undefined,
  handler(args, ctx) {
    const services = requireServiceRegistry(ctx);
    const pendingLines = () => pendingProjectServiceLines(services.pendingProjectServices());
    if (args[0] === 'trust') {
      const name = args[1];
      if (!name) {
        ctx.print(['[services] Usage: /services trust <name> --yes', ...pendingLines()].join('\n'));
        return;
      }
      try {
        const result = services.confirmProjectService(name);
        ctx.print(result.ok
          ? '[services] ' + name + ' from this project is used from now on\n  ' + describePendingProjectService(result.service)
          : '[services] Nothing was confirmed: ' + result.reason + '.');
      } catch (error) {
        if (readRefusal(error)) throw error;
        throw commandRefusal('[services] Nothing was confirmed: the confirmation could not be saved (' + summarizeError(error) + ').');
      }
      return;
    }
    const all = services.getAll();
    const names = Object.keys(all).sort((a, b) => a.localeCompare(b));
    ctx.print([
      names.length ? '[services]' : '[services] No services configured. Add entries to ' + (services.userServicesFilePath || 'your services file') + '.',
      ...names.map((name) => '  ' + name.padEnd(20) + ' ' + (all[name]?.authType ?? '').padEnd(10) + ' ' + (all[name]?.baseUrl ?? '(no url)')),
      ...pendingLines(),
    ].join('\n'));
  },
});

export function registerLocalRuntimeCommands(registry: CommandRegistry): void {
  registry.register(servicesCommand);
  registry.register({
    name: 'expand',
    effect: 'ui-navigation',
    description: 'Expand blocks by type',
    hidden: true,
    usage: '[all|thinking|tool|code]',
    argsHint: '[all|thinking|tool|code]',
    handler(args, ctx) {
      localActions.toggleBlocks(args[0] || 'all', false, ctx);
    },
  });
  registry.register({
    name: 'collapse',
    effect: 'ui-navigation',
    description: 'Collapse blocks by type',
    hidden: true,
    usage: '[all|thinking|tool|code]',
    argsHint: '[all|thinking|tool|code]',
    handler(args, ctx) {
      localActions.toggleBlocks(args[0] || 'all', true, ctx);
    },
  });

  registry.register({
    name: 'activity',
    effect: 'ui-navigation',
    description: 'Show running work, what needs you, what is coming up, and recent activity',
    handler(_args, ctx) {
      if (ctx.openActivityModal) {
        ctx.openActivityModal();
        return;
      }
      ctx.print('The Activity view needs the interactive shell.');
    },
  });

  registry.register({
    name: 'notifications',
    effect: 'ui-navigation',
    description: 'Show every notice and notification in full, newest first',
    handler(_args, ctx) {
      if (ctx.openNotifications) {
        ctx.openNotifications();
        return;
      }
      ctx.print('The notification history needs the interactive shell.');
    },
  });

  registry.register({
    name: 'bookmarks',
    effect: 'ui-navigation',
    aliases: ['bm'],
    description: 'List bookmarked blocks',
    hidden: true,
    handler(_args, ctx) {
      handleBookmarks(ctx, () => requireBookmarkManager(ctx));
    },
  });

  registry.register(secretsCommand);

  registry.register(localActions['image']);

  registry.register({
    name: 'media',
    effect: 'external-network',
    description: 'Inspect media providers or generate media through configured providers',
    hidden: true,
    usage: 'providers | generate [--provider <id>] [--model <id>] [--mime <mime>] <prompt> --yes | generate collect <provider> <task-id> [key=value ...]',
    argsHint: '<providers|generate>',
    async handler(args, ctx) {
      const subcommand = args[0]?.toLowerCase() || 'providers';
      const registry = ctx.platform.mediaProviderRegistry;
      if (!registry) {
        ctx.print('[media] Media providers are not available in this runtime.');
        return;
      }
      if (subcommand === 'providers' || subcommand === 'status' || subcommand === 'list') {
        const statuses = await registry.status();
        ctx.print(
          [
            '[media] Providers:',
            ...statuses.map(
              (provider) =>
                `  ${provider.id}: ${provider.state}${provider.configured ? '' : ' (setup needed)'} - ${provider.capabilities.join(', ')}${provider.detail ? ` - ${provider.detail}` : ''}`,
            ),
          ].join('\n'),
        );
        return;
      }
      if (subcommand !== 'generate') {
        ctx.print('[media] Usage: /media providers | /media generate [--provider <id>] [--model <id>] [--mime <mime>] <prompt> --yes | /media generate collect <provider> <task-id> [key=value ...]');
        return;
      }
      const artifactStore = ctx.platform.artifactStore;
      if (!artifactStore) {
        ctx.print('[media] Artifact storage is not available in this runtime.');
        return;
      }
      if (args[1]?.toLowerCase() === 'collect') {
        // The job was paid for when it was accepted; collecting it spends nothing new, so no --yes.
        const task = parseMediaCollectArgs(args.slice(2));
        if (typeof task === 'string') {
          ctx.print(`[media] ${task} Usage: /media generate collect <provider> <task-id> [key=value ...]`);
          return;
        }
        try {
          const result = await collectAgentMedia(registry, artifactStore, {
            providerId: task.providerId,
            taskId: task.taskId,
            ...(Object.keys(task.resume).length > 0 ? { resume: task.resume } : {}),
          });
          ctx.print(formatAgentMediaGenerationResult(result, mediaCollectCommand));
        } catch (error) {
          if (readRefusal(error)) throw error;
          throw commandRefusal(`[media] Collecting ${task.providerId} task ${task.taskId} failed ${summarizeError(error)}`);
        }
        return;
      }
      const parsed = parseMediaGenerateArgs(args.slice(1));
      if (parsed.errors.length > 0) {
        ctx.print(`[media] ${parsed.errors.join('\n[media] ')}`);
        return;
      }
      if (!parsed.yes) {
        requireYesFlag(
          ctx,
          `generate media for "${parsed.prompt}"`,
          '/media generate [--provider <id>] [--model <id>] [--mime <mime>] <prompt> --yes',
        );
        return;
      }
      try {
        const result = await generateAgentMedia(registry, artifactStore, parsed);
        ctx.print(formatAgentMediaGenerationResult(result, mediaCollectCommand));
      } catch (error) {
        if (readRefusal(error)) throw error;
        throw commandRefusal(`[media] Generation failed ${summarizeError(error)}`);
      }
    },
  });

  registry.register(localActions['refresh-models']);

  registry.register(localActions['pin']);

  registry.register(localActions['unpin']);
}

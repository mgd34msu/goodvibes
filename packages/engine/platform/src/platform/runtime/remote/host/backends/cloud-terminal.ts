import { join } from 'node:path';
import {
  AZURE_CREDENTIAL_SHAPE,
  parseAzureServicePrincipalCredential,
  type AzureServicePrincipalCredential,
  type CloudTerminalBackendConfig,
} from '../peer-registry.js';
import { type Backend, type BackendContext, BackendDispatchError, resolveTimeout, buildRemoteShellCommand } from './types.js';
import { runProcess } from './process-runner.js';
import { tokenizeCommand } from './local-process.js';
import { BackendLifetime } from './backend-lifetime.js';
import { OwnedCredentialDirectory } from './owned-credential-directory.js';
import { redactOwnedCredential } from './credential-output.js';

/**
 * The daemon's own provider sign-in variables. None reaches a cloud CLI, so
 * only the registered credential applies (an inherited AWS_ACCESS_KEY_ID, for
 * one, would override the credentials file the backend hands aws).
 */
const DAEMON_PROVIDER_ENV = /^(AWS_|AZURE_|CLOUDSDK_|GOOGLE_)/;

function inheritedByCloudCli(name: string): boolean {
  return !DAEMON_PROVIDER_ENV.test(name);
}

/** Pinned cloud CLI command shapes with single-use, owned credential scratch. */
export function createCloudTerminalBackend(ctx: BackendContext): Backend {
  const lifetime = new BackendLifetime();
  const scratch = new OwnedCredentialDirectory({
    rootDirectory: join(ctx.homeDirectory, '.goodvibes', 'tui', 'operator', 'cloud-creds'),
    logger: ctx.logger,
  });

  function buildArgs(
    config: CloudTerminalBackendConfig,
    remoteCommand: string,
  ): { args: string[]; credEnvKey?: string } {
    switch (config.provider) {
      case 'gcp': {
        // gcloud compute ssh runs `command` on the target Cloud Shell / instance.
        const args = ['gcloud', 'compute', 'ssh'];
        if (config.projectId) args.push('--project', config.projectId);
        if (config.location) args.push('--zone', config.location);
        args.push(config.instance ?? 'cloudshell', '--command', remoteCommand);
        return { args, credEnvKey: 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE' };
      }
      case 'aws': {
        // aws ssm send-command style: run shell command on a managed instance.
        const args = ['aws', 'ssm', 'start-session'];
        if (config.location) args.push('--region', config.location);
        if (config.instance) args.push('--target', config.instance);
        args.push(
          '--document-name', 'AWS-StartInteractiveCommand',
          // JSON, not the `command=...` shorthand: the CLI splits shorthand on
          // commas and reads `key=value` pairs inside it, so a command holding a
          // comma or `=` would run as something else.
          '--parameters', JSON.stringify({ command: [remoteCommand] }),
        );
        return { args, credEnvKey: 'AWS_SHARED_CREDENTIALS_FILE' };
      }
      case 'azure': {
        // The Azure CLI reads an argument that starts with "@" as the path of a
        // local file and sends that file's contents instead: a command spelled
        // "@/home/user/.ssh/id_rsa" would ship a daemon-side file to the VM.
        if (remoteCommand.trimStart().startsWith('@')) {
          throw new BackendDispatchError(
            'An Azure command cannot start with "@": the Azure CLI would read it as a local file to upload. Nothing was run; start the command with the program to run.',
            'REMOTE_BACKEND_BAD_COMMAND',
            400,
          );
        }
        // az vm run-command invoke executes a script on the target VM. The CLI
        // is signed in first, into a private config directory (see dispatch).
        const args = ['az', 'vm', 'run-command', 'invoke'];
        if (config.projectId) args.push('--resource-group', config.projectId);
        if (config.instance) args.push('--name', config.instance);
        args.push(
          '--command-id', 'RunShellScript',
          '--scripts', remoteCommand,
        );
        return { args };
      }
      default:
        throw new BackendDispatchError(
          `Unsupported cloud provider: ${String(config.provider)}`,
          'REMOTE_BACKEND_UNSUPPORTED_PROVIDER',
        );
    }
  }

  /**
   * Sign the Azure CLI in as the backend's service principal inside
   * `configDir`, so the run-command that follows uses that identity and never
   * the daemon user's own `az login`. The certificate goes by file path, never
   * on argv.
   */
  async function signInToAzure(
    peerId: string,
    principal: AzureServicePrincipalCredential,
    certificatePath: string,
    env: Record<string, string>,
    timeoutMs: number,
    signal: AbortSignal,
    credential: string,
  ): Promise<void> {
    let login;
    try {
      login = await runProcess({
        args: ['az', 'login', '--service-principal', '--username', principal.clientId, '--tenant', principal.tenantId, '--certificate', certificatePath, '--output', 'none'],
        timeoutMs, env, inheritEnv: inheritedByCloudCli, signal,
      });
    } catch {
      lifetime.assertOpen();
      throw new BackendDispatchError(`Could not execute the azure CLI to sign in for peer '${peerId}'.`, 'REMOTE_BACKEND_CREDENTIAL_FAILED');
    }
    if (login.timedOut || login.exitCode !== 0) {
      const detail = redactOwnedCredential(redactOwnedCredential(login.stderr, credential), principal.certificate).trim();
      throw new BackendDispatchError(
        `Signing the azure CLI in as service principal ${principal.clientId} for peer '${peerId}' failed${login.timedOut ? ' (timed out)' : ` (exit ${login.exitCode})`}; nothing was run.${detail ? ` ${detail}` : ''}`,
        'REMOTE_BACKEND_CREDENTIAL_FAILED',
      );
    }
  }

  return {
    kind: 'cloud-terminal',
    dispatch(peer, command, payload) {
      return lifetime.run(async (signal) => {
        if (peer.backendConfig.kind !== 'cloud-terminal') {
          throw new BackendDispatchError(`Peer '${peer.peerId}' is not a cloud-terminal peer.`, 'REMOTE_BACKEND_KIND_MISMATCH');
        }
        const config = { ...peer.backendConfig };
        if (tokenizeCommand(command).length === 0) {
          throw new BackendDispatchError('Empty command.', 'REMOTE_BACKEND_BAD_COMMAND', 400);
        }
        const remoteCommand = buildRemoteShellCommand(command, payload);
        const { args, credEnvKey } = buildArgs(config, remoteCommand);
        let credential: string | null;
        try {
          credential = await lifetime.waitFor(() => ctx.credentials.resolveRef(config.credentialRef));
        } catch {
          lifetime.assertOpen();
          throw new BackendDispatchError(`Could not read cloud credential for peer '${peer.peerId}'.`, 'REMOTE_BACKEND_CREDENTIAL_FAILED');
        }
        if (typeof credential !== 'string' || credential.length === 0) {
          throw new BackendDispatchError(`Could not resolve cloud credential for peer '${peer.peerId}'.`, 'REMOTE_BACKEND_CREDENTIAL_MISSING');
        }
        const secret = credential;
        let principal: AzureServicePrincipalCredential | null = null;
        if (config.provider === 'azure') {
          try {
            principal = parseAzureServicePrincipalCredential(secret);
          } catch {
            throw new BackendDispatchError(
              `The credential of peer '${peer.peerId}' is not an azure service principal; ${AZURE_CREDENTIAL_SHAPE}. Nothing was run.`,
              'REMOTE_BACKEND_INVALID_CONFIG',
              400,
            );
          }
        }
        const owned: string[] = [];
        try {
          const timeoutMs = resolveTimeout(payload);
          const env: Record<string, string> = {};
          if (principal !== null) {
            const certificatePath = await scratch.write(principal.certificate, 'cred');
            owned.push(certificatePath);
            const configDir = await scratch.makeDirectory();
            owned.push(configDir);
            lifetime.assertOpen();
            env['AZURE_CONFIG_DIR'] = configDir;
            await signInToAzure(peer.peerId, principal, certificatePath, env, timeoutMs, signal, secret);
          } else {
            const credPath = await scratch.write(secret, 'cred');
            owned.push(credPath);
            if (credEnvKey) env[credEnvKey] = credPath;
          }
          lifetime.assertOpen();
          ctx.logger.info('remote cloud-terminal dispatch', { peerId: peer.peerId, provider: config.provider });
          let result;
          try {
            result = await runProcess({
              args, timeoutMs, env, inheritEnv: inheritedByCloudCli, signal,
              ...(payload?.stdin !== undefined ? { stdin: payload.stdin } : {}),
            });
          } catch {
            lifetime.assertOpen();
            throw new BackendDispatchError(`Could not execute the ${config.provider} CLI for peer '${peer.peerId}'.`);
          }
          const signedInAs = principal;
          const redact = (text: string): string => {
            const once = redactOwnedCredential(text, secret);
            return signedInAs === null ? once : redactOwnedCredential(once, signedInAs.certificate);
          };
          const stderr = redact(result.stderr);
          return {
            exitCode: result.timedOut ? 124 : result.exitCode,
            stdout: redact(result.stdout),
            stderr: result.timedOut ? `${stderr}\n[remote] cloud command timed out` : stderr,
          };
        } finally {
          for (const path of owned) await scratch.remove(path);
        }
      });
    },
    teardown: () => lifetime.close(() => scratch.close()),
  };
}

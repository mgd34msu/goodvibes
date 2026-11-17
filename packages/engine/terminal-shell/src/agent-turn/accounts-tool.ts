import { agentAccountsWriteGuard, createAgentAccountsInputProjector } from './accounts-admission.js';
import { toolErrorText } from './tool-error-text.js';
import { readString } from './tool-args.js';
/**
 * The `accounts` tool: the durable record of every account the agent created.
 *
 * Creating accounts autonomously, in service of work the owner asked for, is
 * authorized, it is why the agent has its own email address. What was never
 * authorized is doing it invisibly. So the safety mechanism here is visibility,
 * not prohibition: every signup is recorded at creation time, the list is
 * enumerable, and every entry carries the secret-store key name that revocation
 * starts from.
 *
 * `AgentAccountRegistry` had all of this and no caller outside its own test, so
 * an account created today would leave no trace. This is the caller.
 *
 * Only the secret-store key NAME belongs in `credentialSecretKey`. Record
 * fields are screened once, before the taint policy receives them, with a
 * refusal that says where the secret goes instead.
 *
 * The one boundary that does not move: an outward effect refused because
 * untrusted content was read this turn stays refused. A web page describing a
 * signup form cannot cause a signup.
 */

import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { ACCOUNT_REGISTRY_PATH_SEGMENTS, AgentAccountRegistry, mintAddressFor, type AgentAccountRecord } from '@goodvibes-jev/engine/platform/platform/google';
import { readSurfaceEmailSettings } from '@goodvibes-jev/engine/platform/platform/email';
import { containsSecretLikeText } from './memory-safety.js';
import { getSessionExpectationBook, type DaemonExpectationClient } from './session-expectations.js';
import { ConnectedHostVerbError } from './connected-host-verb-error.js';
import { isHostFailure } from './connected-host-client.js';
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.js';
import { evaluateOutwardEffect, getProcessUntrustedContentLedger as getSessionUntrustedContentLedger } from '@goodvibes-jev/engine/platform/platform/security';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';

const ACCOUNT_ACTIONS = ['list', 'alias', 'record', 'forget', 'sweep'] as const;

type ToolOutput = { readonly success: true; readonly output: string } | { readonly success: false; readonly error: string; readonly cancelled?: true };

function failure(message: string): ToolOutput {
  return { success: false, error: message };
}

function ok(output: string): ToolOutput {
  return { success: true, output };
}

function renderAccount(account: AgentAccountRecord): string {
  return [
    `${account.id}  ${account.serviceDomain}`,
    `    created ${account.createdAt} for ${account.purpose}`,
    `    signed up at ${account.serviceUrl} as ${account.aliasAddress}`,
    `    credential: secret-store key ${account.credentialSecretKey}`,
  ].join('\n');
}

export interface AgentAccountsToolOptions {
  readonly registry: AgentAccountRegistry;
  /** Accepted from the runtime wiring; the register's path is the registry's own. */
  readonly shellPaths?: ShellPathService;
  /**
   * The owner's own mailbox, which per-signup aliases are minted from. Read at
   * call time so connecting an account mid-session takes effect.
   */
  readonly baseAddress?: () => string | null;
  /** Secret-store key names, so sweep can drop records whose credential is gone. */
  readonly knownSecretKeys?: () => Promise<readonly string[]>;
  /**
   * The daemon's expectation book. When a daemon is reachable the alias opens
   * its expectation there, so the daemon watches the mailbox and takes the
   * link or code; without one, the session book is used.
   */
  readonly expectations?: DaemonExpectationClient;
}

export function createAgentAccountsTool(options: AgentAccountsToolOptions): Tool {
  const { registry } = options;

  return {
    definition: {
      name: 'accounts',
      description: 'Register of accounts created for the owner.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [...ACCOUNT_ACTIONS],
            description: 'What to do. Record an account as you create it: record requires serviceDomain, serviceUrl, aliasAddress, purpose and credentialSecretKey.',
          },
          serviceDomain: { type: 'string', description: 'Service domain, for alias and record.' },
          serviceUrl: { type: 'string', description: 'The http(s) signup page, for record.' },
          aliasAddress: { type: 'string', description: 'The per-signup alias address used, for record.' },
          purpose: { type: 'string', description: 'What the account is for; required for record, optional for alias.' },
          credentialSecretKey: {
            type: 'string',
            description: 'Secret-store key NAME. Never the credential itself.',
          },
          id: { type: 'string', description: 'Account record id, for forget.' },
          maxAgeDays: { type: 'number', description: 'For sweep: drop records older than this many days. Must be greater than 0.' },
        },
        required: ['action'],
      },
    },
    execute: async (rawArgs: Record<string, unknown>, execution?: Parameters<Tool['execute']>[1]): Promise<ToolOutput> => {
      const cancelled = (): ToolOutput => ({ success: false, cancelled: true, error: 'Account action cancelled.' });
      if (execution?.signal?.aborted) return cancelled();
      try {
        const action = readString(rawArgs.action).toLowerCase();
        if (!ACCOUNT_ACTIONS.some(candidate => candidate === action)) return failure(`accounts needs one of: ${ACCOUNT_ACTIONS.join(', ')}.`);
        const write = agentAccountsWriteGuard(rawArgs, execution);
        if (action === 'alias') {
          // Each signup gets its own delivery address. That address is the
          // correlation key a verification mail is later matched on, so it must
          // be minted per signup rather than reused.
          const serviceDomain = readString(rawArgs.serviceDomain);
          if (!serviceDomain) return failure('accounts action:"alias" needs the serviceDomain you are signing up at.');
          const base = options.baseAddress?.() ?? null;
          if (!base) {
            return failure('No mailbox is connected to mint a signup alias from. Connect one with: /google connect');
          }
          const alias = mintAddressFor(base, serviceDomain);
          const purpose = readString(rawArgs.purpose) || `signing up at ${alias.serviceDomain}`;
          // Opening the expectation here is what lets the verification mail
          // this signup provokes be recognised later. Nothing else opens one,
          // so unsolicited "verify your account" mail is never acted on.
          const daemon = options.expectations;
          if (daemon && daemon.unreachable() === null) {
            write.assertCurrent();
            try {
              const opened = await daemon.open({ serviceDomain: alias.serviceDomain, recipientAddress: alias.address, purpose });
              return ok([
                `Use ${alias.address} as the email address for this signup.`,
                `It delivers to ${alias.baseAddress}, and it is what a verification mail for ${alias.serviceDomain} will be matched on.`,
                `The daemon is watching for its verification mail until ${opened.expiresAt} (expectation ${opened.id}). After submitting the form, wait for it with google action:"mail.verification" expectationId:"${opened.id}"; that returns the link or code once it arrives.`,
                ...(opened.watching && !opened.watching.running ? [`No mailbox is being read right now (${opened.watching.reason}), so the mail cannot arrive until that is fixed.`] : []),
                'Record the account with accounts action:"record" once it exists.',
              ].join('\n'));
            } catch (error) {
              // The daemon refused for a reason that is not about reaching it (the
              // mailbox cannot be read, an unusable address): that is the answer.
              // A host that answered with a refusal (over the wire, or the daemon hosting this turn in process).
              if (error instanceof ConnectedHostVerbError || (isHostFailure(error) && error.refusal.status !== undefined)) {
                return failure(`The daemon would not watch for this signup's verification mail: ${error.message}`);
              }
              throw error;
            }
          }
          const expectation = getSessionExpectationBook().openExpectation({
            serviceDomain: alias.serviceDomain,
            recipientAddress: alias.address,
            purpose,
          }, write.assertCurrent);
          return ok([
            `Use ${alias.address} as the email address for this signup.`,
            `It delivers to ${alias.baseAddress}, and it is what a verification mail for ${alias.serviceDomain} will be matched on.`,
            `Watching for its verification mail until ${expectation.expiresAt}; read it with google action:"mail.verification" (get the message id from google action:"mail.list" first).`,
            'Record the account with accounts action:"record" once it exists.',
          ].join('\n'));
        }

        if (action === 'list') {
          const snapshot = registry.snapshot();
          if (snapshot.unreadable !== undefined) {
            return failure(`The account register at ${snapshot.path} could not be read (${snapshot.unreadable}), so the list is unknown rather than empty. The file was not changed; repair or restore it before relying on this list.`);
          }
          if (snapshot.accounts.length === 0) {
            if (snapshot.droppedOnRead > 0) {
              return failure(`${snapshot.droppedOnRead} record(s) could not be read from ${snapshot.path}, so the list is unknown rather than empty. The file was not changed; repair or restore it before relying on this list.`);
            }
            return ok(`No accounts have been recorded. The register lives at ${snapshot.path}.`);
          }
          const dropped = snapshot.droppedOnRead > 0
            ? `\n\n${snapshot.droppedOnRead} malformed record(s) were dropped when reading ${snapshot.path}.`
            : '';
          return ok(`${snapshot.accounts.map(renderAccount).join('\n')}${dropped}`);
        }

        if (action === 'record') {
          // Refuse protected values before the taint policy can send field text
          // to judgment. Read once so policy and persistence see the same
          // values across the awaited reading.
          const input = {
            serviceDomain: readString(rawArgs.serviceDomain),
            serviceUrl: readString(rawArgs.serviceUrl),
            aliasAddress: readString(rawArgs.aliasAddress),
            purpose: readString(rawArgs.purpose),
            credentialSecretKey: readString(rawArgs.credentialSecretKey),
          };
          if (Object.values(input).some(containsSecretLikeText)) {
            return failure('The account registry cannot store secret-looking values. Store the secret in the secret store and record only its key name.');
          }
          // Recording is the visible half of an outward effect that already
          // happened, so it is gated the same way the signup itself is: page
          // text cannot drive the agent into registering an account.
          const ledger = getSessionUntrustedContentLedger();
          // The comparison context is also judgment input. Refuse, rather than
          // erase evidence and accidentally authorize a tainted account write.
          if ([...ledger.taintSourcesThisTurn(), ...ledger.exposuresThisTurn()]
            .some((source) => Object.values(source).some(containsSecretLikeText))) {
            return failure('Account safety cannot inspect protected values in untrusted context. No record was written.');
          }
          const decision = await evaluateOutwardEffect({
            request: {
              toolName: 'accounts',
              action: 'accounts.record',
              description: `recording an account created at ${input.serviceDomain || 'a service'}`,
            },
            ledger,
            // Enumerated rather than left to the coarse rule. Every field of a
            // record is text a page could have supplied, the domain and the URL
            // most of all, since a record pointing at an attacker's host is how
            // a forged signup would be made to look like a real one. Without
            // these, recording an account after reading any page was refused
            // outright, which is the friction that gets a check switched off.
            content: {
              serviceDomain: input.serviceDomain || undefined,
              serviceUrl: input.serviceUrl || undefined,
              aliasAddress: input.aliasAddress || undefined,
              purpose: input.purpose || undefined,
            },
            taintOptions: {
              // The domain and the URL are short and high-signal: the value
              // itself is the payload, so containment is the test rather than
              // length. The alias is deliberately NOT here, the agent minted it
              // for this signup, so of course it appears in the mail that signup
              // provoked, and testing it would refuse every real record.
              exactMatchFields: ['serviceDomain', 'serviceUrl'],
              signal: execution?.signal,
            },
            requestedBy: 'owner-direct',
            sourcePolicy: 'required',
          });
          if (execution?.signal?.aborted) return cancelled();
          if (!decision.allowed) return failure(`${decision.reason} ${decision.fix}`);

          const account = registry.record(input, write);
          return ok(`Recorded:\n${renderAccount(account)}`);
        }

        if (action === 'forget') {
          const id = readString(rawArgs.id);
          if (!id) return failure('accounts action:"forget" needs the record id, from accounts action:"list".');
          const removed = registry.forget(id, write);
          return ok(
            `Forgot the record for ${removed.serviceDomain}. This removed the RECORD only, the account at ${removed.serviceUrl} still exists, and its credential is still under secret-store key ${removed.credentialSecretKey}.`,
          );
        }

        // Zero or a negative age puts the cutoff at or after now, which would
        // reap every record, so only a positive finite number is an age.
        if (rawArgs.maxAgeDays !== undefined && !(typeof rawArgs.maxAgeDays === 'number' && Number.isFinite(rawArgs.maxAgeDays) && rawArgs.maxAgeDays > 0)) {
          return failure('accounts action:"sweep" needs maxAgeDays to be a number greater than 0 (records older than that many days are dropped). No record was removed.');
        }
        const maxAgeDays = rawArgs.maxAgeDays;
        const known = options.knownSecretKeys ? [...await options.knownSecretKeys()] : undefined;
        if (execution?.signal?.aborted) return cancelled();
        const result = registry.sweep({
          ...(known === undefined ? {} : { knownSecretKeys: known }),
          ...(maxAgeDays === undefined ? {} : { maxAgeDays }),
        }, write);
        const credentialCheck = known === undefined
          ? ' Credential presence could not be checked (the secret store is not connected), so only the age rule was applied.'
          : '';
        return ok(
          result.removed.length === 0
            ? `Nothing to reap; ${result.remaining} record(s) remain.${credentialCheck}`
            : `Reaped ${result.removed.length} record(s) whose credential was gone or which aged out: ${result.removed.map((entry) => entry.id).join(', ')}. ${result.remaining} remain.${credentialCheck}`,
        );
      } catch (error) {
        if (execution?.signal?.aborted) return cancelled();
        return failure(toolErrorText(error));
      }
    },
  };
}

export function registerAgentAccountsTool(registry: ToolRegistry, options: AgentAccountsToolOptions): void {
  if (!registry.has('accounts')) registry.register(createAgentAccountsTool(options), { inputProjection: createAgentAccountsInputProjector() });
}

/**
 * The accounts register as a turn composes it, in either process: the
 * Agent's register under the home, and the owner's mailbox read from this
 * process's settings at call time. `expectations`: the daemon's
 * verification-mail book; absent, the session book is used.
 */
export function agentAccountsToolOptions(shellPaths: ShellPathService, settings: { get(key: string): unknown },
  expectations?: DaemonExpectationClient): AgentAccountsToolOptions {
  return {
    shellPaths,
    // The platform registry takes its store path and its "does this look like a
    // credential" rule as inputs rather than deriving either: the path so no
    // product writes into another's storage root, the predicate because the
    // wording of that judgement belongs to the product that shows it.
    registry: new AgentAccountRegistry({
      storePath: shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, ...ACCOUNT_REGISTRY_PATH_SEGMENTS),
      containsSecretLikeText,
    }),
    baseAddress: () => readSurfaceEmailSettings((key) => settings.get(key)).fromAddress ?? null,
    ...(expectations ? { expectations } : {}),
  };
}

import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import {
  buildIncidentMemoryAddOptions,
  buildMcpSecurityMemoryAddOptions,
  buildPluginSecurityMemoryAddOptions,
  buildPolicyPreflightMemoryAddOptions,
  type ProvenanceLink,
} from '@goodvibes-jev/engine/platform/platform/state';
import { VALID_CLASSES, VALID_SCOPES, isValidClass, isValidScope } from './recall-shared.js';
export interface RecallCaptureContext {
  readonly print: (message: string) => void;
  readonly session: {
    readonly runtime: {
      readonly sessionId: string;
    };
  };
  readonly extensions: {
    readonly forensicsRegistry?:
      | {
          latest():
            | {
                readonly id: string;
              }
            | null
            | undefined;
          getById(id: string):
            | {
                readonly id: string;
              }
            | null
            | undefined;
          buildBundle(id: string): Parameters<typeof buildIncidentMemoryAddOptions>[0] | null | undefined;
        }
      | null
      | undefined;
    readonly policyRuntimeState?:
      | {
          getSnapshot(): {
            readonly lastPreflightReview?: Parameters<typeof buildPolicyPreflightMemoryAddOptions>[0] | null | undefined;
          };
        }
      | null
      | undefined;
    readonly mcpRegistry: {
      listServerSecurity(): readonly Parameters<typeof buildMcpSecurityMemoryAddOptions>[0][];
    };
    readonly pluginManager?:
      | {
          list(): readonly Parameters<typeof buildPluginSecurityMemoryAddOptions>[0][];
          getQuarantineRecord(name: string):
            | {
                readonly reason: string;
              }
            | null
            | undefined;
        }
      | null
      | undefined;
  };
}
export function createRecallCaptureCommands<Context extends RecallCaptureContext>(
  getMemory: (context: Context) => Pick<MemoryApi, 'add'> | null,
  presentation: {
    readonly tag: string;
    readonly command: string;
    readonly validValuesLabel: string;
    readonly validValuesSuffix: string;
    readonly missingItemSeparator: string;
    readonly printAdded: (
      context: Context,
      record: Awaited<ReturnType<MemoryApi['add']>>,
      cls: Parameters<MemoryApi['add']>[0]['cls'],
    ) => void;
  },
) {
  async function handleRecallAdd(args: string[], context: Context): Promise<void> {
    const memory = getMemory(context);
    if (!memory) {
      return;
    }
    const cls = args[0];
    if (!cls || !isValidClass(cls)) {
      context.print(
        `${presentation.tag} Invalid class "${cls ?? ''}". ${presentation.validValuesLabel} ${VALID_CLASSES.join(', ')}${presentation.validValuesSuffix}`,
      );
      return;
    }
    const flagArgs = args.slice(1);
    const detailIdx = flagArgs.indexOf('--detail');
    const tagsIdx = flagArgs.indexOf('--tags');
    const sessionIdx = flagArgs.indexOf('--session');
    const taskIdx = flagArgs.indexOf('--task');
    const fileIdx = flagArgs.indexOf('--file');
    const scopeIdx = flagArgs.indexOf('--scope');
    const detail = detailIdx !== -1 ? flagArgs[detailIdx + 1] : undefined;
    const tagsRaw = tagsIdx !== -1 ? flagArgs[tagsIdx + 1] : undefined;
    const scopeRaw = scopeIdx !== -1 ? flagArgs[scopeIdx + 1] : undefined;
    const tags = tagsRaw
      ? tagsRaw
          .split(',')
          .map((token) => token.trim())
          .filter(Boolean)
      : [];
    const scope = scopeRaw && isValidScope(scopeRaw) ? scopeRaw : 'project';
    if (scopeRaw && !isValidScope(scopeRaw)) {
      context.print(
        `${presentation.tag} Invalid scope "${scopeRaw}". ${presentation.validValuesLabel} ${VALID_SCOPES.join(', ')}${presentation.validValuesSuffix}`,
      );
      return;
    }
    const provenance: ProvenanceLink[] = [];
    const sessionRef = sessionIdx !== -1 ? flagArgs[sessionIdx + 1] : undefined;
    if (sessionRef) provenance.push({ kind: 'session', ref: sessionRef });
    const taskRef = taskIdx !== -1 ? flagArgs[taskIdx + 1] : undefined;
    if (taskRef) provenance.push({ kind: 'task', ref: taskRef });
    const fileRef = fileIdx !== -1 ? flagArgs[fileIdx + 1] : undefined;
    if (fileRef) provenance.push({ kind: 'file', ref: fileRef });
    if (!provenance.some((entry) => entry.kind === 'session') && context.session.runtime.sessionId) {
      provenance.push({ kind: 'session', ref: context.session.runtime.sessionId });
    }
    const summaryTokens: string[] = [];
    for (const token of flagArgs) {
      if (token.startsWith('--')) break;
      summaryTokens.push(token);
    }
    const summary = summaryTokens.join(' ');
    if (!summary.trim()) {
      context.print(`${presentation.tag} Usage: /${presentation.command} add <class> <summary> [--detail <text>] [--tags <t1,t2>]`);
      return;
    }
    const record = await memory.add({ scope, cls, summary, detail, tags, provenance });
    presentation.printAdded(context, record, cls);
  }
  async function handleRecallCapture(args: string[], context: Context): Promise<void> {
    const memory = getMemory(context);
    const pluginManager = context.extensions.pluginManager;
    if (!memory) {
      return;
    }
    if (!context.extensions.forensicsRegistry) {
      context.print(`${presentation.tag} Forensics registry not available.`);
      return;
    }
    const target = args[0];
    if (target === 'incident') {
      const requestedId = args[1];
      const report =
        !requestedId || requestedId === 'latest'
          ? context.extensions.forensicsRegistry.latest()
          : context.extensions.forensicsRegistry.getById(requestedId);
      if (!report) {
        context.print(`${presentation.tag} Incident not found${presentation.missingItemSeparator}${requestedId ?? 'latest'}`);
        return;
      }
      const bundle = context.extensions.forensicsRegistry.buildBundle(report.id);
      if (!bundle) {
        context.print(`${presentation.tag} Failed to build incident bundle${presentation.missingItemSeparator}${report.id}`);
        return;
      }
      const record = await memory.add(buildIncidentMemoryAddOptions(bundle));
      context.print(`${presentation.tag} Captured incident ${report.id} into memory as ${record.id}`);
      return;
    }
    if (target === 'policy') {
      const review = context.extensions.policyRuntimeState?.getSnapshot().lastPreflightReview;
      if (!review) {
        context.print(`${presentation.tag} No policy preflight review is available to capture.`);
        return;
      }
      const record = await memory.add(buildPolicyPreflightMemoryAddOptions(review));
      context.print(`${presentation.tag} Captured policy preflight into memory as ${record.id}`);
      return;
    }
    if (target === 'mcp') {
      const serverName = args[1];
      if (!serverName) {
        context.print(`${presentation.tag} Usage: /${presentation.command} capture mcp <server>`);
        return;
      }
      const server = context.extensions.mcpRegistry.listServerSecurity().find((entry) => entry.name === serverName);
      if (!server) {
        context.print(`${presentation.tag} MCP server not found${presentation.missingItemSeparator}${serverName}`);
        return;
      }
      const record = await memory.add(buildMcpSecurityMemoryAddOptions(server));
      context.print(`${presentation.tag} Captured MCP server ${server.name} into memory as ${record.id}`);
      return;
    }
    if (target === 'plugin') {
      if (!pluginManager) {
        context.print(`${presentation.tag} Plugin manager not available.`);
        return;
      }
      const pluginName = args[1];
      if (!pluginName) {
        context.print(`${presentation.tag} Usage: /${presentation.command} capture plugin <name>`);
        return;
      }
      const plugin = pluginManager.list().find((entry) => entry.name === pluginName);
      if (!plugin) {
        context.print(`${presentation.tag} Plugin not found${presentation.missingItemSeparator}${pluginName}`);
        return;
      }
      const quarantineReason = pluginManager.getQuarantineRecord(plugin.name)?.reason;
      const record = await memory.add(buildPluginSecurityMemoryAddOptions(plugin, quarantineReason));
      context.print(`${presentation.tag} Captured plugin ${plugin.name} into memory as ${record.id}`);
      return;
    }
    context.print(
      `${presentation.tag} Usage: /${presentation.command} capture incident <id|latest> | /${presentation.command} capture policy | /${presentation.command} capture mcp <server> | /${presentation.command} capture plugin <name>`,
    );
  }
  return { handleRecallAdd, handleRecallCapture };
}

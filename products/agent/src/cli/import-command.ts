import { isAbsolute, resolve } from 'node:path';
import { optionArgsOf } from '@goodvibes/engine/terminal-shell/cli-parser-engine';
import { assertNoSecretLikeMemoryText } from '@goodvibes/engine/terminal-shell/agent-turn/memory-safety';
import { withMemoryCommandStore } from './memory-command-access.ts';
import { buildAgentSkillRequirements } from '@goodvibes/engine/terminal-shell/agent-turn/skill-registry';
import type { CliCommandOutput } from './types.ts';
import type { CliCommandRuntime } from './management.ts';
import { failure, personaRegistry, skillRegistry, success } from './local-library-command-shared.ts';
import {
  OPENCLAW_LAYOUT_VERSION,
  scanOpenClawWorkspace,
  type OpenClawImportPlan,
} from './openclaw-import.ts';

/**
 * `goodvibes-agent import openclaw [path]`, migrate an OpenClaw workspace into
 * the Agent's existing registries. Dry-run is the DEFAULT (prints what would be
 * created). --apply writes the content: memory (through the same store the
 * `memory` command uses), personas and skills. Permission grants are applied
 * only with --apply-permissions: a grant pre-allows every tool in a category
 * for this Agent profile, so it is asked for by its own flag, listed with what
 * it covers, and printed with the commands that undo it. No parallel storage is
 * invented. See openclaw-import.ts for the targeted layout.
 */

/** What a blanket allow of each category lets the Agent do without asking. */
const CATEGORY_COVERS: Readonly<Record<string, string>> = {
  read: 'read any file',
  find: 'search and list any file',
  write: 'create or overwrite any file',
  edit: 'change any file',
  exec: 'run any shell command',
  fetch: 'make network requests to any host',
  analyze: 'run code analysis',
  inspect: 'inspect the project and its processes',
  agent: 'start sub-agents',
  state: "read and change the Agent's own state and memory",
  workflow: 'run workflows',
  registry: 'change tool and skill registries',
  delegate: 'hand work to GoodVibes TUI',
  mcp: 'call any MCP server tool',
};

/** Categories whose blanket allow lets the Agent change files or reach the network and the shell. */
const BROAD_CATEGORIES: ReadonlySet<string> = new Set(['exec', 'write', 'edit', 'fetch']);

interface ApplyCounts {
  created: number;
  /** Already present from an earlier run of this import. */
  unchanged: number;
  skipped: number;
}

function resolveSourcePath(runtime: CliCommandRuntime, arg: string | undefined): string {
  // Home is taken from the runtime's owned home root (the composition root passes
  // it in), never discovered implicitly. Default workspace is <home>/.openclaw.
  if (!arg) return resolve(runtime.homeDirectory, '.openclaw');
  if (arg.startsWith('~')) return resolve(runtime.homeDirectory, arg.slice(1).replace(/^[/\\]/, ''));
  if (isAbsolute(arg)) return arg;
  return resolve(runtime.workingDirectory, arg);
}

function planSummaryLines(plan: OpenClawImportPlan): string[] {
  const lines: string[] = [];
  lines.push(`  personas: ${plan.personas.length}`);
  for (const persona of plan.personas) lines.push(`    - ${persona.name}  (${persona.sourcePath})`);
  lines.push(`  memory records: ${plan.memories.length}`);
  for (const memory of plan.memories) lines.push(`    - ${memory.scope}/${memory.cls}  ${memory.summary}`);
  lines.push(`  skills: ${plan.skills.length}`);
  for (const skill of plan.skills) lines.push(`    - ${skill.name}  (${skill.sourcePath})`);
  const perm = plan.permissions;
  lines.push(`  permission allowlist: ${perm.categories.length} categor${perm.categories.length === 1 ? 'y' : 'ies'}${perm.sourcePath ? ` (${perm.sourcePath})` : ''}`);
  if (perm.categories.length > 0) {
    lines.push(`    - allow: ${perm.categories.join(', ')}  (recorded as per-tool entries; they follow the execution mode, which is not changed)`);
    const broad = perm.categories.filter((category) => BROAD_CATEGORIES.has(category));
    if (broad.length > 0) {
      lines.push(`    - warning: ${broad.join(', ')} would be allowed for every tool in the category, not only the arguments the OpenClaw entry named`);
    }
    lines.push('    - not applied by --apply; add --apply-permissions to grant them');
  }
  lines.push(`  skipped: ${plan.skipped.length}`);
  for (const entry of plan.skipped) lines.push(`    - ${entry.path}: ${entry.reason}`);
  return lines;
}

function renderDryRun(plan: OpenClawImportPlan): string {
  return [
    `OpenClaw import (dry run), layout ${OPENCLAW_LAYOUT_VERSION}`,
    `  source ${plan.sourcePath}`,
    ...planSummaryLines(plan),
    '',
    '  This is a preview. Re-run with --apply to write the personas, memory and skills into the Agent registries,',
    '  and add --apply-permissions to grant the permission categories as well.',
  ].join('\n');
}

async function applyMemories(
  runtime: CliCommandRuntime,
  plan: OpenClawImportPlan,
  notes: string[],
): Promise<ApplyCounts & { readonly store: string }> {
  const counts: ApplyCounts = { created: 0, unchanged: 0, skipped: 0 };
  if (plan.memories.length === 0) return { ...counts, store: 'none needed' };
  // The same store `goodvibes-agent memory` uses: the host's over the wire when
  // it answers, never a second copy of the file underneath a running daemon.
  return await withMemoryCommandStore(runtime, true, async ({ access, label }) => {
    // The store gives every record a fresh id and never dedupes, so a second
    // import would double the memories. A record from the same source file with
    // the same summary is the one this import made: one literal listing (no
    // query, so no ranking) answers that for every planned record.
    const imported = new Set<string>();
    for (const record of await access.list({})) {
      for (const link of record.provenance) {
        if (link.ref.startsWith('openclaw-import:')) imported.add(`${link.ref}\n${record.summary}`);
      }
    }
    for (const memory of plan.memories) {
      try {
        const ref = `openclaw-import:${memory.sourcePath}`;
        if (imported.has(`${ref}\n${memory.summary}`)) {
          counts.unchanged += 1;
          continue;
        }
        assertNoSecretLikeMemoryText([memory.summary, memory.detail ?? '', ...memory.tags]);
        await access.add({
          scope: memory.scope as 'session' | 'project' | 'team',
          cls: memory.cls as 'fact',
          summary: memory.summary,
          detail: memory.detail,
          tags: [...memory.tags],
          provenance: [{ kind: 'event', ref }],
        });
        counts.created += 1;
      } catch (error) {
        counts.skipped += 1;
        notes.push(`  memory skipped (${memory.summary}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { ...counts, store: label };
  });
}

function applyPersonas(runtime: CliCommandRuntime, plan: OpenClawImportPlan, notes: string[]): ApplyCounts {
  const counts: ApplyCounts = { created: 0, unchanged: 0, skipped: 0 };
  const registry = personaRegistry(runtime);
  for (const persona of plan.personas) {
    const existing = registry.get(persona.name);
    if (existing?.provenance === `openclaw-import:${persona.sourcePath}`) {
      counts.unchanged += 1;
      continue;
    }
    try {
      registry.create({
        name: persona.name,
        description: persona.description,
        body: persona.body,
        tags: [...persona.tags],
        source: 'imported',
        provenance: `openclaw-import:${persona.sourcePath}`,
      });
      counts.created += 1;
    } catch (error) {
      counts.skipped += 1;
      notes.push(`  persona skipped (${persona.name}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return counts;
}

function applySkills(runtime: CliCommandRuntime, plan: OpenClawImportPlan, notes: string[]): ApplyCounts {
  const counts: ApplyCounts = { created: 0, unchanged: 0, skipped: 0 };
  const registry = skillRegistry(runtime);
  for (const skill of plan.skills) {
    const existing = registry.get(skill.name);
    if (existing?.provenance === `openclaw-import:${skill.sourcePath}`) {
      counts.unchanged += 1;
      continue;
    }
    try {
      registry.create({
        name: skill.name,
        description: skill.description,
        procedure: skill.procedure,
        tags: [...skill.tags],
        requirements: buildAgentSkillRequirements({ env: skill.requiresEnv, commands: skill.requiresCommand }),
        source: 'imported',
        provenance: `openclaw-import:${skill.sourcePath}`,
      });
      counts.created += 1;
    } catch (error) {
      counts.skipped += 1;
      notes.push(`  skill skipped (${skill.name}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return counts;
}

/** Grants each category the allowlist named, returning the lines that say what changed and how to undo it. */
function applyPermissions(runtime: CliCommandRuntime, plan: OpenClawImportPlan): string[] {
  const categories = plan.permissions.categories;
  if (categories.length === 0) return ['  permission grants: none in the workspace allowlist'];
  const granted: string[] = [];
  const lines: string[] = [];
  // The execution mode is the owner's choice and is left as it is; the per-tool
  // entries are what the OpenClaw allowlist said, and they follow that mode.
  for (const category of categories) {
    const key = `permissions.tools.${category}`;
    if (runtime.configManager.get(key as never) === 'allow') {
      lines.push(`    - ${category}: already allowed`);
      continue;
    }
    runtime.configManager.setDynamic(key as never, 'allow');
    granted.push(category);
    lines.push(`    - ${category}: may now ${CATEGORY_COVERS[category] ?? `use every ${category} tool`} without asking, in every project of this Agent profile`);
  }
  return [
    `  permission grants applied ${granted.length}${plan.permissions.sourcePath ? ` (from ${plan.permissions.sourcePath})` : ''}`,
    ...lines,
    ...(granted.length > 0 ? ['  undo (inside the Agent):', ...granted.map((category) => `    /settings reset permissions.tools.${category}`)] : []),
  ];
}

function countLine(label: string, counts: ApplyCounts): string {
  const extra = [
    counts.unchanged ? `unchanged ${counts.unchanged}` : '',
    counts.skipped ? `skipped ${counts.skipped}` : '',
  ].filter(Boolean).join(', ');
  return `  ${label} created ${counts.created}${extra ? ` (${extra})` : ''}`;
}

async function renderApply(
  runtime: CliCommandRuntime,
  plan: OpenClawImportPlan,
  withPermissions: boolean,
): Promise<{ readonly text: string; readonly skipped: number }> {
  const notes: string[] = [];
  const header = [`OpenClaw import (applied), layout ${OPENCLAW_LAYOUT_VERSION}`, `  source ${plan.sourcePath}`];
  // Memory first: it is the part that can be refused (a connected host that did
  // not answer), and a refusal then leaves nothing half-applied behind it.
  let memories: Awaited<ReturnType<typeof applyMemories>>;
  try {
    memories = await applyMemories(runtime, plan, notes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: [...header, `  memory records not written: ${message}`, '  personas, skills and permissions were not applied; nothing changed.'].join('\n'),
      skipped: plan.memories.length + plan.personas.length + plan.skills.length,
    };
  }
  const written: string[] = [countLine('memory records', memories), `    store ${memories.store}`];
  let personas: ApplyCounts | null = null;
  let skills: ApplyCounts | null = null;
  let permissionLines: string[] = [];
  let failedPart: string | null = null;
  try {
    personas = applyPersonas(runtime, plan, notes);
    written.push(countLine('personas', personas));
    skills = applySkills(runtime, plan, notes);
    written.push(countLine('skills', skills));
    permissionLines = withPermissions
      ? applyPermissions(runtime, plan)
      : plan.permissions.categories.length > 0
        ? [`  permission grants not applied (${plan.permissions.categories.join(', ')}); add --apply-permissions to grant them`]
        : [];
  } catch (error) {
    failedPart = `${personas === null ? 'personas' : skills === null ? 'skills' : 'permissions'}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const skippedItems = memories.skipped + (personas?.skipped ?? plan.personas.length) + (skills?.skipped ?? plan.skills.length);
  const text = [
    ...header,
    ...written,
    ...permissionLines,
    `  execution mode ${String(runtime.configManager.get('permissions.mode'))}${withPermissions && plan.permissions.categories.length ? '; the per-tool allow entries follow this mode and do not change it' : ''}`,
    `  input files skipped ${plan.skipped.length}`,
    ...(failedPart ? [`  stopped at ${failedPart}; the parts listed above were written`] : []),
    ...(skippedItems > 0 || failedPart ? [`  result partial: ${skippedItems} item${skippedItems === 1 ? '' : 's'} not created (see notes); exit 1`] : []),
    ...notes,
  ].join('\n');
  return { text, skipped: skippedItems + (failedPart ? 1 : 0) };
}

function usageImport(): string {
  return 'Usage: goodvibes-agent import openclaw [path] [--apply] [--apply-permissions]';
}

export async function handleImportCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  try {
    // --apply and --apply-permissions are read only from what was typed before `--`.
    const [sourceRaw, ...rest] = optionArgsOf(runtime.cli);
    const source = (sourceRaw ?? '').toLowerCase();
    if (!source) return failure(runtime, 'invalid_import_command', usageImport(), 2);
    if (source !== 'openclaw') {
      return failure(runtime, 'unknown_import_source', `Unknown import source "${sourceRaw}". Supported sources: openclaw.\n${usageImport()}`, 2);
    }
    const withPermissions = rest.includes('--apply-permissions');
    const apply = rest.includes('--apply') || withPermissions;
    const pathArg = rest.find((arg) => !arg.startsWith('--')) ?? runtime.cli.literalArgs?.[0];
    const sourcePath = resolveSourcePath(runtime, pathArg);
    const plan = scanOpenClawWorkspace(sourcePath);
    if (!plan.exists) {
      const message = pathArg
        ? `OpenClaw workspace not found at ${sourcePath}.`
        : `No OpenClaw workspace found at the default location ${sourcePath}. Pass a path: goodvibes-agent import openclaw <path>.`;
      return failure(runtime, 'openclaw_workspace_missing', message, 1);
    }
    if (apply) {
      const applied = await renderApply(runtime, plan, withPermissions);
      return { ...success(runtime, 'agent.import.openclaw.apply', { ...plan, itemsSkipped: applied.skipped }, applied.text), exitCode: applied.skipped > 0 ? 1 : 0 };
    }
    return success(runtime, 'agent.import.openclaw.dryRun', plan, renderDryRun(plan));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(runtime, 'agent.import.error', message, 1);
  }
}

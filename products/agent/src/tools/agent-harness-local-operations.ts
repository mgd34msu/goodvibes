import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { requireConfirmedAction } from './agent-harness-tool-utils.ts';
import { AgentNoteRegistry, type AgentNotePromotion } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { AgentPersonaRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { AgentRoutineRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { AgentSkillRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { CommandContext } from '../input/command-registry.ts';
import {
  createKnowledgeUrlEditorFromNote,
  createMemoryEditorFromNote,
  createMemoryUpdateEditor,
  createNoteUpdateEditor,
  createPersonaEditorFromNote,
  createPersonaUpdateEditor,
  createRoutineEditorFromNote,
  createRoutineUpdateEditor,
  createSkillEditorFromNote,
  createSkillUpdateEditor,
  splitList,
} from '../input/agent-workspace-editors.ts';
import type { AgentWorkspaceAction, AgentWorkspaceLocalEditor, AgentWorkspaceLocalOperation } from '../input/agent-workspace-types.ts';

export interface AgentHarnessLocalOperationArgs {
  readonly fields?: unknown;
  readonly recordId?: unknown;
  readonly id?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export interface AgentHarnessLocalOperationDeps {
  readonly commandContext: {
    readonly workspace: Pick<CommandContext['workspace'], 'shellPaths'>;
    readonly clients?: Pick<NonNullable<CommandContext['clients']>, 'agentKnowledgeApi'>;
  };
  readonly toolRegistry: ToolRegistry;
}

type HarnessResult =
  | { readonly success: true; readonly output: string }
  | { readonly success: false; readonly error: string };

type RegistryDomain = 'memory' | 'note' | 'persona' | 'skill' | 'routine';
type RegistryAction = 'update' | 'review' | 'stale' | 'delete' | 'use' | 'clear_active' | 'enable' | 'disable' | 'start';

interface RegistryTarget {
  readonly domain: RegistryDomain;
  readonly action: RegistryAction;
  readonly requiresRecordId: boolean;
}

function output(value: unknown): HarnessResult {
  return { success: true, output: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isScalarField(entry: unknown): entry is string | number | boolean {
  return typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean';
}

function readFieldMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  // An object or array has no faithful text form; String() would store "[object Object]" in a record.
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => isScalarField(entry)).map(([key, entry]) => [key, String(entry)]));
}

function nonScalarFieldNames(value: unknown): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value).filter(([, entry]) => !isScalarField(entry)).map(([key]) => key);
}

function invalidFieldsResult(fields: unknown): { readonly success: false; readonly error: string } | null {
  const names = nonScalarFieldNames(fields);
  return names.length > 0 ? error(`Field values must be text, numbers or booleans. Not accepted: ${names.join(', ')}. Resend them as plain text.`) : null;
}

const NOTE_PROMOTION_PREFIX = 'agent-harness-note-promotion';

function isNotePromotion(operation: AgentWorkspaceLocalOperation): boolean {
  return operation.startsWith('note-promote-');
}

/** The registry domain a note promotion writes, or null for the knowledge-URL ingest. */
function notePromotionDomain(operation: AgentWorkspaceLocalOperation): AgentNotePromotion['domain'] | null {
  if (operation === 'note-promote-memory') return 'memory';
  if (operation === 'note-promote-persona') return 'persona';
  if (operation === 'note-promote-skill') return 'skill';
  if (operation === 'note-promote-routine') return 'routine';
  return null;
}

let nestedCallSequence = 0;

function describeEditor(editor: AgentWorkspaceLocalEditor): Record<string, unknown> {
  return {
    kind: editor.kind,
    mode: editor.mode,
    recordId: editor.recordId,
    title: editor.title,
    message: editor.message,
    fields: editor.fields.map((field) => ({
      id: field.id,
      label: field.label,
      required: field.required,
      multiline: field.multiline,
      hint: field.hint,
      default: field.redact ? '<redacted>' : field.value,
    })),
  };
}

function readRecordId(args: AgentHarnessLocalOperationArgs): string {
  const fields = readFieldMap(args.fields);
  return readString(args.recordId ?? args.id ?? fields.recordId ?? fields.id);
}

function fieldReader(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>): (id: string) => string {
  return (id: string) => fields[id] ?? editor.fields.find((field) => field.id === id)?.value ?? '';
}

function hasExecutionFields(args: AgentHarnessLocalOperationArgs): boolean {
  return Object.keys(readFieldMap(args.fields)).some((key) => key !== 'id' && key !== 'recordId');
}

function missingRequiredFields(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>): readonly string[] {
  const read = fieldReader(editor, fields);
  return editor.fields.filter((field) => field.required && !read(field.id).trim()).map((field) => field.id);
}

function registryTarget(operation: AgentWorkspaceLocalOperation): RegistryTarget | null {
  if (operation === 'memory-edit') return { domain: 'memory', action: 'update', requiresRecordId: true };
  if (operation === 'memory-review') return { domain: 'memory', action: 'review', requiresRecordId: true };
  if (operation === 'memory-stale') return { domain: 'memory', action: 'stale', requiresRecordId: true };
  if (operation === 'memory-delete') return { domain: 'memory', action: 'delete', requiresRecordId: true };
  if (operation === 'note-edit') return { domain: 'note', action: 'update', requiresRecordId: true };
  if (operation === 'note-review') return { domain: 'note', action: 'review', requiresRecordId: true };
  if (operation === 'note-stale') return { domain: 'note', action: 'stale', requiresRecordId: true };
  if (operation === 'note-delete') return { domain: 'note', action: 'delete', requiresRecordId: true };
  if (operation === 'persona-edit') return { domain: 'persona', action: 'update', requiresRecordId: true };
  if (operation === 'persona-use') return { domain: 'persona', action: 'use', requiresRecordId: true };
  if (operation === 'persona-review') return { domain: 'persona', action: 'review', requiresRecordId: true };
  if (operation === 'persona-clear') return { domain: 'persona', action: 'clear_active', requiresRecordId: false };
  if (operation === 'persona-delete') return { domain: 'persona', action: 'delete', requiresRecordId: true };
  if (operation === 'skill-edit') return { domain: 'skill', action: 'update', requiresRecordId: true };
  if (operation === 'skill-enable') return { domain: 'skill', action: 'enable', requiresRecordId: true };
  if (operation === 'skill-disable') return { domain: 'skill', action: 'disable', requiresRecordId: true };
  if (operation === 'skill-review') return { domain: 'skill', action: 'review', requiresRecordId: true };
  if (operation === 'skill-delete') return { domain: 'skill', action: 'delete', requiresRecordId: true };
  if (operation === 'routine-edit') return { domain: 'routine', action: 'update', requiresRecordId: true };
  if (operation === 'routine-start') return { domain: 'routine', action: 'start', requiresRecordId: true };
  if (operation === 'routine-enable') return { domain: 'routine', action: 'enable', requiresRecordId: true };
  if (operation === 'routine-disable') return { domain: 'routine', action: 'disable', requiresRecordId: true };
  if (operation === 'routine-review') return { domain: 'routine', action: 'review', requiresRecordId: true };
  if (operation === 'routine-delete') return { domain: 'routine', action: 'delete', requiresRecordId: true };
  return null;
}

function editorForOperation(context: AgentHarnessLocalOperationDeps['commandContext'], operation: AgentWorkspaceLocalOperation, recordId: string): AgentWorkspaceLocalEditor | null {
  const shellPaths = context.workspace.shellPaths;
  if (operation === 'memory-edit') {
    const record = context.clients?.agentKnowledgeApi?.memory?.get(recordId);
    return record ? createMemoryUpdateEditor(record) : null;
  }
  if (!shellPaths) return null;
  if (operation === 'note-edit') {
    const note = AgentNoteRegistry.fromShellPaths(shellPaths).get(recordId);
    return note ? createNoteUpdateEditor(note) : null;
  }
  if (operation === 'note-promote-memory' || operation === 'note-promote-persona' || operation === 'note-promote-skill' || operation === 'note-promote-routine' || operation === 'note-promote-knowledge-url') {
    const note = AgentNoteRegistry.fromShellPaths(shellPaths).get(recordId);
    if (!note) return null;
    if (operation === 'note-promote-memory') return createMemoryEditorFromNote(note);
    if (operation === 'note-promote-persona') return createPersonaEditorFromNote(note);
    if (operation === 'note-promote-skill') return createSkillEditorFromNote(note);
    if (operation === 'note-promote-routine') return createRoutineEditorFromNote(note);
    return note.sourceUrl ? createKnowledgeUrlEditorFromNote(note) : null;
  }
  if (operation === 'persona-edit') {
    const registry = AgentPersonaRegistry.fromShellPaths(shellPaths);
    const persona = registry.get(recordId);
    return persona ? createPersonaUpdateEditor(persona, registry.snapshot().activePersonaId === persona.id) : null;
  }
  if (operation === 'skill-edit') {
    const skill = AgentSkillRegistry.fromShellPaths(shellPaths).get(recordId);
    return skill ? createSkillUpdateEditor(skill) : null;
  }
  if (operation === 'routine-edit') {
    const routine = AgentRoutineRegistry.fromShellPaths(shellPaths).get(recordId);
    return routine ? createRoutineUpdateEditor(routine) : null;
  }
  return null;
}

/**
 * The record an earlier promotion of this note already created in the target
 * domain, if any. The note's own `promoted` list is the record both promotion
 * paths (this workspace action and learning auto-promotion) write and read;
 * the provenance markers below answer only for notes promoted before it existed.
 */
function existingNotePromotion(context: AgentHarnessLocalOperationDeps['commandContext'], operation: AgentWorkspaceLocalOperation, noteId: string, editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>): { readonly domain: string; readonly id: string } | null {
  const shellPaths = context.workspace.shellPaths;
  const domain = notePromotionDomain(operation);
  const recorded = domain && shellPaths ? AgentNoteRegistry.fromShellPaths(shellPaths).get(noteId)?.promoted?.find((entry) => entry.domain === domain) : undefined;
  if (recorded) return { domain: recorded.domain, id: recorded.id };
  const marker = `${NOTE_PROMOTION_PREFIX}:${noteId}`;
  if (operation === 'note-promote-persona' && shellPaths) {
    const found = AgentPersonaRegistry.fromShellPaths(shellPaths).list().find((record) => record.provenance === marker);
    return found ? { domain: 'persona', id: found.id } : null;
  }
  if (operation === 'note-promote-skill' && shellPaths) {
    const found = AgentSkillRegistry.fromShellPaths(shellPaths).list().find((record) => record.provenance === marker);
    return found ? { domain: 'skill', id: found.id } : null;
  }
  if (operation === 'note-promote-routine' && shellPaths) {
    const found = AgentRoutineRegistry.fromShellPaths(shellPaths).list().find((record) => record.provenance === marker);
    return found ? { domain: 'routine', id: found.id } : null;
  }
  if (operation === 'note-promote-memory') {
    const read = fieldReader(editor, fields);
    const summary = read('summary').trim().toLowerCase(), detail = read('detail').trim();
    const found = context.clients?.agentKnowledgeApi?.memory?.getAll().find((record) => record.summary.trim().toLowerCase() === summary && (record.detail ?? '').trim() === detail);
    return found ? { domain: 'memory', id: found.id } : null;
  }
  return null;
}

type RegistryArgsResult =
  | { readonly success: true; readonly args: Record<string, unknown> }
  | { readonly success: false; readonly error: string };

function localRegistryArgsFromEditor(editor: AgentWorkspaceLocalEditor, fields: Readonly<Record<string, string>>, id?: string, sourceNoteId?: string): RegistryArgsResult {
  const read = fieldReader(editor, fields);
  const supplied = (field: string) => editor.mode !== 'update' || Object.hasOwn(fields, field);
  const args: Record<string, unknown> = {
    domain: editor.kind,
    action: editor.mode === 'update' ? 'update' : 'create',
    ...(id ? { id } : {}),
    // The note id in the promotion marker is what lets a repeated promotion be recognised and refused.
    provenance: editor.recordId ? 'agent-harness-local-operation' : sourceNoteId ? `${NOTE_PROMOTION_PREFIX}:${sourceNoteId}` : NOTE_PROMOTION_PREFIX,
  };
  const textFields = editor.kind === 'memory' ? ['cls', 'scope', 'summary', 'detail']
    : editor.kind === 'note' ? ['title', 'body', 'sourceUrl']
    : editor.kind === 'persona' ? ['name', 'description', 'body']
    : editor.kind === 'skill' ? ['name', 'description', 'procedure']
    : ['name', 'description', 'steps'];
  const listFields = editor.kind === 'memory' || editor.kind === 'note' ? ['tags']
    : ['tags', 'triggers'];
  for (const field of textFields) if (supplied(field)) args[field] = read(field);
  for (const field of listFields) if (supplied(field)) args[field] = splitList(read(field));
  if (editor.kind === 'skill' || editor.kind === 'routine') {
    const requirementFields = ['requiresEnv', 'requiresCommands'] as const;
    if (editor.mode !== 'update' || requirementFields.some(field => Object.hasOwn(fields, field))) {
      for (const field of requirementFields) {
        if (editor.mode === 'update' && !Object.hasOwn(fields, field)
          && !editor.fields.some(descriptor => descriptor.id === field)) {
          return error('Workspace requirement update needs the current paired requirement field.');
        }
        args[field] = splitList(read(field));
      }
    }
  }
  if (editor.kind === 'memory' && supplied('confidence')) {
    const value = read('confidence').trim();
    if (value) {
      const confidence = Number(value);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
        return error('Workspace memory confidence must be a finite number between 0 and 100.');
      }
      args.confidence = confidence;
    }
  }
  const booleanField = editor.kind === 'persona' ? 'activate'
    : editor.kind === 'skill' || editor.kind === 'routine' ? 'enabled' : null;
  if (booleanField && supplied(booleanField)) {
    const value = read(booleanField).trim().toLowerCase();
    if (value) {
      if (value !== 'yes' && value !== 'no') return error(`Workspace ${booleanField} must be yes or no.`);
      args[booleanField] = value === 'yes';
    }
  }
  return { success: true, args };
}

function localRegistryArgsForTarget(target: RegistryTarget, args: AgentHarnessLocalOperationArgs, recordId: string): RegistryArgsResult {
  const fields = readFieldMap(args.fields);
  const base = { domain: target.domain, action: target.action, ...(recordId ? { id: recordId } : {}) };
  const edit: RegistryArgsResult = target.action === 'update' ? localRegistryArgsFromEditor({ kind: target.domain, mode: 'update', recordId, title: '', selectedFieldIndex: 0, message: '', fields: [] }, fields, recordId) : { success: true, args: {} };
  if (!edit.success) return edit;
  return { success: true, args: {
    ...base,
    ...edit.args,
    ...(target.action === 'stale' && fields.reason ? { reason: fields.reason } : {}),
    ...(readString(args.explicitUserRequest) ? { explicitUserRequest: readString(args.explicitUserRequest) } : {}),
  } };
}

/** The nested tool's result as data: parsed JSON, or its text with the id of a record it created. */
function nestedResult(text: string): { readonly result: unknown; readonly createdId: string | null } {
  try { return { result: JSON.parse(text), createdId: null }; } catch { /* plain text result */ }
  const created = /^Created\b/.test(text) ? /^\s*id (\S+)\s*$/m.exec(text)?.[1] ?? null : null;
  return { result: text, createdId: created };
}

async function executeTool(toolRegistry: ToolRegistry, name: string, toolArgs: Record<string, unknown>, options: Parameters<Tool['execute']>[1],
  onCreated?: (id: string) => void): Promise<HarnessResult> {
  if (!toolRegistry.has(name)) return output({ status: 'model_tool_required', modelExecution: { tool: name, args: toolArgs } });
  const result = await toolRegistry.executeNested(`agent-harness-${name}-${Date.now()}-${++nestedCallSequence}`, name, toolArgs, options) as { readonly success: boolean; readonly output?: string; readonly error?: string };
  if (!result.success) return error(result.error ?? `${name} failed.`);
  const nested = nestedResult(result.output ?? '');
  if (nested.createdId) onCreated?.(nested.createdId);
  return output({ status: 'executed_model_tool', tool: name, result: nested.result, ...(nested.createdId ? { createdId: nested.createdId } : {}) });
}

export function describeLocalWorkspaceModelExecution(action: AgentWorkspaceAction): Record<string, unknown> | null {
  if (action.kind === 'local-selection') return { tool: 'agent_local_registry', domain: action.localKind, actions: ['list', 'search', 'get'], note: 'TUI selection maps to recordId for model-run local-operation actions.' };
  if (!action.localOperation) return null;
  const target = registryTarget(action.localOperation);
  if (target) return { tool: 'agent_local_registry', domain: target.domain, action: target.action, requiresRecordId: target.requiresRecordId };
  if (action.localOperation === 'note-promote-knowledge-url') return { tool: 'agent_knowledge_ingest', sourceKind: 'url', requiresRecordId: true, selectedRecordDomain: 'note' };
  return { tool: 'agent_local_registry', selectedRecordDomain: 'note', action: 'create', requiresRecordId: true };
}

export async function runLocalWorkspaceEditorAction(
  deps: AgentHarnessLocalOperationDeps,
  editor: AgentWorkspaceLocalEditor,
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<HarnessResult> {
  const fields = readFieldMap(args.fields);
  const missing = missingRequiredFields(editor, fields);
  if (missing.length > 0) {
    return output({
      status: 'missing_required_fields',
      missing,
      editor: describeEditor(editor),
    });
  }
  const confirmationError = requireConfirmedAction(args, options, 'Workspace local registry editor action');
  if (confirmationError) return error(confirmationError);
  const invalidFields = invalidFieldsResult(args.fields);
  if (invalidFields) return invalidFields;
  if (
    editor.kind !== 'memory'
    && editor.kind !== 'note'
    && editor.kind !== 'persona'
    && editor.kind !== 'skill'
    && editor.kind !== 'routine'
  ) {
    return output({
      status: 'model_tool_required',
      editor: describeEditor(editor),
    });
  }
  const built = localRegistryArgsFromEditor(editor, fields, editor.recordId);
  if (!built.success) return built;
  return executeTool(
    deps.toolRegistry,
    'agent_local_registry',
    built.args,
    options,
  );
}

export async function runLocalWorkspaceAction(
  deps: AgentHarnessLocalOperationDeps,
  action: AgentWorkspaceAction,
  args: Record<string, unknown>,
  options?: Parameters<Tool['execute']>[1],
): Promise<HarnessResult> {
  if (action.kind === 'local-selection') return output({ status: 'local_selection', action: action.id, modelExecution: describeLocalWorkspaceModelExecution(action) });
  const operation = action.localOperation;
  if (!operation) return output({ status: 'local_registry_action', action: action.id, modelExecution: describeLocalWorkspaceModelExecution(action) });
  const target = registryTarget(operation);
  const recordId = readRecordId(args);
  if ((target?.requiresRecordId || isNotePromotion(operation)) && !recordId) return output({ status: 'needs_record_id', action: action.id, modelExecution: describeLocalWorkspaceModelExecution(action) });
  const editor = recordId ? editorForOperation(deps.commandContext, operation, recordId) : null;
  if (!editor && recordId && isNotePromotion(operation)) {
    // Without an editor nothing can be built, so say why instead of returning a generic hand-off.
    const shellPaths = deps.commandContext.workspace.shellPaths;
    const noteExists = shellPaths ? AgentNoteRegistry.fromShellPaths(shellPaths).get(recordId) !== null : false;
    const noSourceUrl = operation === 'note-promote-knowledge-url' && noteExists;
    return output({ status: noSourceUrl ? 'note_has_no_source_url' : 'record_not_found', action: action.id, recordId, domain: 'note',
      reason: noSourceUrl ? 'The note has no source URL to ingest.' : 'No note with that id was found.' });
  }
  if (editor && !hasExecutionFields(args)) return output({ status: 'editor', action: action.id, editor: describeEditor(editor), modelExecution: describeLocalWorkspaceModelExecution(action) });
  const confirmationError = requireConfirmedAction(args, options, 'Workspace local registry action');
  if (confirmationError) return error(confirmationError);
  const invalidFields = invalidFieldsResult(args.fields);
  if (invalidFields) return invalidFields;
  if (editor) {
    const fields = readFieldMap(args.fields);
    const missing = missingRequiredFields(editor, fields);
    if (missing.length > 0) return output({ status: 'missing_required_fields', missing, action: action.id, editor: describeEditor(editor) });
    if (editor.kind === 'knowledge-url') return executeTool(deps.toolRegistry, 'agent_knowledge_ingest', { sourceKind: 'url', url: fieldReader(editor, fields)('url'), tags: splitList(fieldReader(editor, fields)('tags')), folderPath: fieldReader(editor, fields)('folder'), ...(readString(args.explicitUserRequest) ? { explicitUserRequest: readString(args.explicitUserRequest) } : {}) }, options);
    if (isNotePromotion(operation)) {
      const existing = existingNotePromotion(deps.commandContext, operation, recordId, editor, fields);
      if (existing) return output({ status: 'already_promoted', action: action.id, noteId: recordId, existing, note: 'This note was already promoted into that domain, so nothing new was created. Edit the existing record instead.' });
    }
    const built = localRegistryArgsFromEditor(editor, fields, isNotePromotion(operation) ? undefined : recordId, isNotePromotion(operation) ? recordId : undefined);
    if (!built.success) return built;
    const domain = notePromotionDomain(operation), shellPaths = deps.commandContext.workspace.shellPaths;
    return executeTool(deps.toolRegistry, 'agent_local_registry', built.args, options, domain && shellPaths
      ? id => { AgentNoteRegistry.fromShellPaths(shellPaths).recordPromotion(recordId, { domain, id }); } : undefined);
  }
  if (!target) return output({ status: 'local_registry_action', action: action.id, modelExecution: describeLocalWorkspaceModelExecution(action) });
  const built = localRegistryArgsForTarget(target, args, recordId);
  if (!built.success) return built;
  return executeTool(deps.toolRegistry, 'agent_local_registry', built.args, options);
}

import type { ShellPathService } from '@/runtime/index.ts';
import { AgentNoteRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/note-registry';
import { AgentPersonaRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/persona-registry';
import { AgentRoutineRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/routine-registry';
import { createAgentRuntimeProfile, type AgentRuntimeProfileInfo } from '../agent/runtime-profile.ts';
import { AgentSkillRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/skill-registry';
import { createAgentWorkspaceLearnedBehavior } from './agent-workspace-learned-behavior.ts';
import { buildAgentWorkspaceRequirements } from './agent-workspace-requirements.ts';
import { isEnabledValue, splitList } from './agent-workspace-editors.ts';
import type { AgentWorkspaceLocalEditor, AgentWorkspaceLocalEditorKind } from './agent-workspace-types.ts';

type LearnedBehaviorTarget = Exclude<AgentWorkspaceLocalEditorKind, 'memory' | 'note' | 'profile'>;

export interface AgentWorkspaceLocalEditorSubmissionCallbacks {
  readonly readField: (id: string) => string;
  readonly learnedBehaviorTarget: () => LearnedBehaviorTarget;
  readonly submitDeleteEditor: () => void;
  readonly finishLocalEditor: (kind: AgentWorkspaceLocalEditorKind, id: string, name: string, verb: 'Created' | 'Updated') => void;
  readonly finishProfileEditor: (profile: AgentRuntimeProfileInfo) => void;
}

export function submitAgentWorkspaceLocalRegistryEditor(
  shellPaths: ShellPathService,
  editor: AgentWorkspaceLocalEditor,
  callbacks: AgentWorkspaceLocalEditorSubmissionCallbacks,
): void {
  const field = callbacks.readField;
  if (editor.mode === 'delete') {
    callbacks.submitDeleteEditor();
    return;
  }
  if (editor.kind === 'learned-behavior') {
    const created = createAgentWorkspaceLearnedBehavior(shellPaths, {
      target: callbacks.learnedBehaviorTarget(),
      name: field('name'),
      description: field('description'),
      notes: field('notes'),
      tags: splitList(field('tags')),
      triggers: splitList(field('triggers')),
      enable: isEnabledValue(field('enable')),
    });
    callbacks.finishLocalEditor(created.kind, created.id, created.name, 'Created');
  } else if (editor.kind === 'profile') {
    const template = field('template');
    const templateId = template && template.toLowerCase() !== 'none' ? template : undefined;
    const profile = createAgentRuntimeProfile(shellPaths.homeDirectory, field('name'), {
      ...(templateId ? { templateId } : {}),
    });
    callbacks.finishProfileEditor(profile);
  } else if (editor.kind === 'note') {
    submitNoteEditor(shellPaths, editor, field, callbacks.finishLocalEditor);
  } else if (editor.kind === 'persona') {
    submitPersonaEditor(shellPaths, editor, field, callbacks.finishLocalEditor);
  } else if (editor.kind === 'skill') {
    submitSkillEditor(shellPaths, editor, field, callbacks.finishLocalEditor);
  } else if (editor.kind === 'routine') {
    submitRoutineEditor(shellPaths, editor, field, callbacks.finishLocalEditor);
  } else {
    throw new Error(`This form isn't wired to a save action yet (kind: ${editor.kind}).`);
  }
}

function submitNoteEditor(
  shellPaths: ShellPathService,
  editor: AgentWorkspaceLocalEditor,
  field: (id: string) => string,
  finish: AgentWorkspaceLocalEditorSubmissionCallbacks['finishLocalEditor'],
): void {
  const registry = AgentNoteRegistry.fromShellPaths(shellPaths);
  if (editor.mode === 'update' && editor.recordId) {
    const updated = registry.update(editor.recordId, {
      title: field('title'),
      body: field('body'),
      sourceUrl: field('sourceUrl'),
      tags: splitList(field('tags')),
      provenance: 'Workspace',
    });
    finish('note', updated.id, updated.title, 'Updated');
    return;
  }
  const created = registry.create({
    title: field('title'),
    body: field('body'),
    sourceUrl: field('sourceUrl'),
    tags: splitList(field('tags')),
    source: 'user',
    provenance: 'Workspace',
  });
  finish('note', created.id, created.title, 'Created');
}

function submitPersonaEditor(
  shellPaths: ShellPathService,
  editor: AgentWorkspaceLocalEditor,
  field: (id: string) => string,
  finish: AgentWorkspaceLocalEditorSubmissionCallbacks['finishLocalEditor'],
): void {
  const registry = AgentPersonaRegistry.fromShellPaths(shellPaths);
  if (editor.mode === 'update' && editor.recordId) {
    const updated = registry.update(editor.recordId, {
      name: field('name'),
      description: field('description'),
      body: field('body'),
      tags: splitList(field('tags')),
      triggers: splitList(field('triggers')),
      provenance: 'Workspace',
      active: isEnabledValue(field('activate')),
    });
    finish('persona', updated.id, updated.name, 'Updated');
    return;
  }
  const created = registry.create({
    name: field('name'),
    description: field('description'),
    body: field('body'),
    tags: splitList(field('tags')),
    triggers: splitList(field('triggers')),
    source: 'user',
    provenance: 'Workspace',
    active: isEnabledValue(field('activate')),
  });
  finish('persona', created.id, created.name, 'Created');
}

function submitSkillEditor(
  shellPaths: ShellPathService,
  editor: AgentWorkspaceLocalEditor,
  field: (id: string) => string,
  finish: AgentWorkspaceLocalEditorSubmissionCallbacks['finishLocalEditor'],
): void {
  const registry = AgentSkillRegistry.fromShellPaths(shellPaths);
  if (editor.mode === 'update' && editor.recordId) {
    const updated = registry.update(editor.recordId, {
      name: field('name'),
      description: field('description'),
      procedure: field('procedure'),
      triggers: splitList(field('triggers')),
      tags: splitList(field('tags')),
      requirements: buildAgentWorkspaceRequirements(field),
      enabled: isEnabledValue(field('enabled')),
      provenance: 'Workspace',
    });
    finish('skill', updated.id, updated.name, 'Updated');
    return;
  }
  const created = registry.create({
    name: field('name'),
    description: field('description'),
    procedure: field('procedure'),
    triggers: splitList(field('triggers')),
    tags: splitList(field('tags')),
    requirements: buildAgentWorkspaceRequirements(field),
    enabled: isEnabledValue(field('enabled')),
    source: 'user',
    provenance: 'Workspace',
  });
  finish('skill', created.id, created.name, 'Created');
}

function submitRoutineEditor(
  shellPaths: ShellPathService,
  editor: AgentWorkspaceLocalEditor,
  field: (id: string) => string,
  finish: AgentWorkspaceLocalEditorSubmissionCallbacks['finishLocalEditor'],
): void {
  const registry = AgentRoutineRegistry.fromShellPaths(shellPaths);
  if (editor.mode === 'update' && editor.recordId) {
    const updated = registry.update(editor.recordId, {
      name: field('name'),
      description: field('description'),
      steps: field('steps'),
      triggers: splitList(field('triggers')),
      tags: splitList(field('tags')),
      requirements: buildAgentWorkspaceRequirements(field),
      enabled: isEnabledValue(field('enabled')),
      provenance: 'Workspace',
    });
    finish('routine', updated.id, updated.name, 'Updated');
    return;
  }
  const created = registry.create({
    name: field('name'),
    description: field('description'),
    steps: field('steps'),
    triggers: splitList(field('triggers')),
    tags: splitList(field('tags')),
    requirements: buildAgentWorkspaceRequirements(field),
    enabled: isEnabledValue(field('enabled')),
    source: 'user',
    provenance: 'Workspace',
  });
  finish('routine', created.id, created.name, 'Created');
}

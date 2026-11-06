import { createOnboardingConfigApply } from '@goodvibes-jev/engine/terminal-shell/onboarding-config-apply';
import {
  createOnboardingApplyPipeline,
  orderOnboardingOperations,
  prevalidateOnboardingOperations,
  onboardingVerificationFailureKind,
} from '@goodvibes-jev/engine/terminal-shell/onboarding-apply-pipeline';
import { createOnboardingConfigValidator } from '@goodvibes-jev/engine/terminal-shell/onboarding-config-validation';
const { validateConfigValue } = createOnboardingConfigValidator<Extract<OnboardingApplyOperation, { kind: 'set-config' }>>({
  separator: ' ',
  validateExtension: validateLegacyFeatureConfigValue,
});
import { createOnboardingApplyPrimitives } from '@goodvibes-jev/engine/terminal-shell/onboarding-apply-primitives';
import { existsSync, rmSync } from 'node:fs';
import '@goodvibes-jev/engine/sdk/platform/config';
import '../../config/index.ts';
import {
  createAgentRuntimeProfile,
  getAgentRuntimeProfileTemplate,
  getAgentRuntimeProfileSelectionPath,
  resolveAgentRuntimeProfileHome,
  setAgentRuntimeProfileSelection,
} from '../../agent/runtime-profile.ts';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentPersonaRegistry, assertNoSecretLikeText } from '../../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { expandLegacyFeatureConfigValue, isLegacyFeatureConfigKey } from '../feature-enablement.ts';
import { getOnboardingRuntimeStatePath, readOnboardingRuntimeState, writeOnboardingAcknowledgementState } from './state.ts';
import { verifyOnboardingRequest } from './verify.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import type {
  OnboardingApplyDependencies,
  OnboardingAppliedOperation,
  OnboardingApplyError,
  OnboardingApplyOperation,
  OnboardingApplyRequest,
} from './types.ts';
import {
  readJsonObject,
  restoreFile,
  runRollbacks,
  setNestedValue,
  snapshotFileRollback,
  writeJsonObject,
  type RollbackAction,
} from './apply-file-helpers.ts';

function validateLegacyFeatureConfigValue(operation: Extract<OnboardingApplyOperation, { kind: 'set-config' }>): boolean {
  if (!isLegacyFeatureConfigKey(operation.key)) return false;
  // Throws with real guidance on malformed shapes, unknown feature ids, and
  // always-available (constant-binding) features. The legacy featureFlags
  // namespace dissolved onto domain settings keys; the expansion below is
  // exactly what apply will write.
  expandLegacyFeatureConfigValue(operation.key, operation.value);
  return true;
}

function validateAuthOperation(
  _deps: OnboardingApplyDependencies,
  _operation: Extract<OnboardingApplyOperation, { kind: 'ensure-auth-user' }>,
): void {
  throw new Error('Runtime auth user/session administration is external to GoodVibes Agent onboarding.');
}

function validateCreateAgentProfileOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-agent-profile' }>,
): void {
  const name = operation.name.trim();
  if (name.length === 0) throw new Error('Agent profile name is required.');

  const resolution = resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, name);
  if (existsSync(resolution.homeDirectory)) {
    throw new Error(`Agent profile already exists: ${resolution.id}`);
  }

  const templateId = operation.templateId?.trim();
  if (templateId) getAgentRuntimeProfileTemplate(templateId, deps.shellPaths.homeDirectory);
}

function validateSelectAgentProfileOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'select-agent-profile' }>,
): void {
  const name = operation.name.trim();
  if (name.length === 0) throw new Error('Agent profile name is required.');
  const resolution = resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, name);
  if (!existsSync(resolution.homeDirectory)) {
    throw new Error(`Agent profile does not exist: ${resolution.id}`);
  }
}

function validateCreateLocalPersonaOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-persona' }>,
): void {
  const name = operation.name.trim();
  const description = operation.description.trim();
  const body = operation.body.trim();
  if (!name) throw new Error('Persona name is required.');
  if (!description) throw new Error('Persona description is required.');
  if (!body) throw new Error('Persona body is required.');
  assertNoSecretLikeText([name, description, body]);
  const duplicate = AgentPersonaRegistry.fromShellPaths(deps.shellPaths).get(name);
  if (duplicate) throw new Error(`Persona already exists: ${duplicate.id}`);
}

function validateCreateLocalSkillOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-skill' }>,
): void {
  const registry = AgentSkillRegistry.fromShellPaths(deps.shellPaths);
  const name = operation.name.trim();
  const description = operation.description.trim();
  const procedure = operation.procedure.trim();
  if (!name) throw new Error('Skill name is required.');
  if (!description) throw new Error('Skill description is required.');
  if (!procedure) throw new Error('Skill procedure is required.');
  assertNoSecretLikeText([name, description, procedure]);
  const duplicate = registry.get(name);
  if (duplicate) throw new Error(`Skill already exists: ${duplicate.id}`);
}

function validateCreateLocalRoutineOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-routine' }>,
): void {
  const registry = AgentRoutineRegistry.fromShellPaths(deps.shellPaths);
  const name = operation.name.trim();
  const description = operation.description.trim();
  const steps = operation.steps.trim();
  if (!name) throw new Error('Routine name is required.');
  if (!description) throw new Error('Routine description is required.');
  if (!steps) throw new Error('Routine steps are required.');
  assertNoSecretLikeText([name, description, steps]);
  const duplicate = registry.get(name);
  if (duplicate) throw new Error(`Routine already exists: ${duplicate.id}`);
}

function validateCreateLocalNoteOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-note' }>,
): void {
  const registry = AgentNoteRegistry.fromShellPaths(deps.shellPaths);
  const title = operation.title.trim();
  const body = operation.body.trim();
  const tags = operation.tags ?? [];
  if (!title) throw new Error('Note title is required.');
  if (!body) throw new Error('Note body is required.');
  assertNoSecretLikeText([title, body, ...tags]);
  const duplicate = registry.get(title);
  if (duplicate) throw new Error(`Note already exists: ${duplicate.id}`);
}

const { applyConfigOperation, buildConfigRollbackAction, validateConfigOperation } = createOnboardingConfigApply<
  OnboardingApplyDependencies,
  Extract<OnboardingApplyOperation, { kind: 'set-config' }>
>({
  validate: validateConfigValue,
  projectPath: (deps) => deps.shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'settings.json'),
  readJsonObject,
  writeJsonObject,
  setNestedValue,
  snapshotFileRollback,
  reload: (deps) => deps.config.load(),
  get: (deps, key) => deps.config.get(key as never),
  set: (deps, key, value) => deps.config.setDynamic(key as never, value),
  translate: (operation) =>
    isLegacyFeatureConfigKey(operation.key) ? expandLegacyFeatureConfigValue(operation.key, operation.value) : undefined,
});

async function buildRollbackAction(deps: OnboardingApplyDependencies, operation: OnboardingApplyOperation): Promise<RollbackAction> {
  if (operation.kind === 'set-config') return buildConfigRollbackAction(deps, operation);

  if (operation.kind === 'set-secret') {
    return buildSecretRollbackAction(deps, operation);
  }

  if (operation.kind === 'ensure-auth-user') {
    validateAuthOperation(deps, operation);
    return () => {};
  }

  if (operation.kind === 'acknowledge') {
    return snapshotFileRollback(getOnboardingRuntimeStatePath(deps.shellPaths, deps.acknowledgementScope ?? 'project'));
  }

  if (operation.kind === 'create-agent-profile') {
    const resolution = resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, operation.name);
    return () => {
      if (existsSync(resolution.homeDirectory)) rmSync(resolution.homeDirectory, { recursive: true, force: true });
    };
  }

  if (operation.kind === 'select-agent-profile') {
    const path = getAgentRuntimeProfileSelectionPath(deps.shellPaths.homeDirectory);
    return snapshotFileRollback(path);
  }

  if (operation.kind === 'create-local-note') {
    const registry = AgentNoteRegistry.fromShellPaths(deps.shellPaths);
    return snapshotFileRollback(registry.snapshot().path);
  }

  if (operation.kind === 'create-local-persona') {
    const registry = AgentPersonaRegistry.fromShellPaths(deps.shellPaths);
    return snapshotFileRollback(registry.snapshot().path);
  }

  if (operation.kind === 'create-local-skill') {
    const registry = AgentSkillRegistry.fromShellPaths(deps.shellPaths);
    return snapshotFileRollback(registry.snapshot().path);
  }

  if (operation.kind === 'create-local-routine') {
    const registry = AgentRoutineRegistry.fromShellPaths(deps.shellPaths);
    return snapshotFileRollback(registry.snapshot().path);
  }

  const neverOperation: never = operation;
  throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
}

function applyCreateAgentProfileOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-agent-profile' }>,
): OnboardingAppliedOperation {
  validateCreateAgentProfileOperation(deps, operation);
  const templateId = operation.templateId?.trim();
  const profile = createAgentRuntimeProfile(deps.shellPaths.homeDirectory, operation.name, {
    ...(templateId ? { templateId } : {}),
  });

  return {
    kind: operation.kind,
    summary: profile.starterTemplateId
      ? `Created Agent profile ${profile.id} from ${profile.starterTemplateId}.`
      : `Created Agent profile ${profile.id}.`,
  };
}

function applySelectAgentProfileOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'select-agent-profile' }>,
): OnboardingAppliedOperation {
  validateSelectAgentProfileOperation(deps, operation);
  const selection = setAgentRuntimeProfileSelection(deps.shellPaths.homeDirectory, operation.name);
  return {
    kind: operation.kind,
    summary: `Selected Agent profile ${selection.id} for later plain goodvibes-agent runs.`,
  };
}

function applyCreateLocalPersonaOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-persona' }>,
): OnboardingAppliedOperation {
  const registry = AgentPersonaRegistry.fromShellPaths(deps.shellPaths);
  const persona = registry.create({
    name: operation.name,
    description: operation.description,
    body: operation.body,
    source: 'user',
    provenance: 'onboarding',
  });
  if (operation.activate !== false) registry.setActive(persona.id);
  return {
    kind: operation.kind,
    summary: `Created Agent-local persona ${persona.id}.`,
  };
}

function applyCreateLocalSkillOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-skill' }>,
): OnboardingAppliedOperation {
  const skill = AgentSkillRegistry.fromShellPaths(deps.shellPaths).create({
    name: operation.name,
    description: operation.description,
    procedure: operation.procedure,
    enabled: operation.enabled !== false,
    source: 'user',
    provenance: 'onboarding',
  });
  return {
    kind: operation.kind,
    summary: `Created Agent-local skill ${skill.id}.`,
  };
}

function applyCreateLocalRoutineOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-routine' }>,
): OnboardingAppliedOperation {
  const routine = AgentRoutineRegistry.fromShellPaths(deps.shellPaths).create({
    name: operation.name,
    description: operation.description,
    steps: operation.steps,
    enabled: operation.enabled !== false,
    source: 'user',
    provenance: 'onboarding',
  });
  return {
    kind: operation.kind,
    summary: `Created Agent-local routine ${routine.id}.`,
  };
}

function applyCreateLocalNoteOperation(
  deps: OnboardingApplyDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-note' }>,
): OnboardingAppliedOperation {
  const note = AgentNoteRegistry.fromShellPaths(deps.shellPaths).create({
    title: operation.title,
    body: operation.body,
    tags: operation.tags ?? [],
    source: 'user',
    provenance: 'onboarding',
  });
  return {
    kind: operation.kind,
    summary: `Created Agent-local note ${note.id}.`,
  };
}

const orderApplyOperations = (operations: readonly OnboardingApplyOperation[]): readonly OnboardingApplyOperation[] =>
  orderOnboardingOperations(operations, [
    ['create-agent-profile'],
    ['select-agent-profile'],
    ['create-local-note', 'create-local-persona', 'create-local-skill', 'create-local-routine'],
  ]);

function prevalidateApplyRequest(deps: OnboardingApplyDependencies, request: OnboardingApplyRequest): OnboardingApplyError[] {
  return prevalidateOnboardingOperations(
    orderApplyOperations(request.operations),
    (operation, orderedOperations) => {
      if (operation.kind === 'set-config') {
        validateConfigOperation(deps, operation);
        return;
      }

      if (operation.kind === 'set-secret') {
        validateSecretOperation(deps, operation);
        return;
      }

      if (operation.kind === 'ensure-auth-user') {
        validateAuthOperation(deps, operation);
        return;
      }

      if (operation.kind === 'acknowledge') {
        validateAcknowledgementOperation(deps, operation);
        return;
      }

      if (operation.kind === 'create-agent-profile') {
        validateCreateAgentProfileOperation(deps, operation);
        return;
      }

      if (operation.kind === 'select-agent-profile') {
        const createdEarlier = orderedOperations.some(
          (candidate) =>
            candidate.kind === 'create-agent-profile' &&
            resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, candidate.name).id ===
              resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, operation.name).id,
        );
        if (!createdEarlier) validateSelectAgentProfileOperation(deps, operation);
        return;
      }

      if (operation.kind === 'create-local-persona') {
        validateCreateLocalPersonaOperation(deps, operation);
        return;
      }

      if (operation.kind === 'create-local-note') {
        validateCreateLocalNoteOperation(deps, operation);
        return;
      }

      if (operation.kind === 'create-local-skill') {
        validateCreateLocalSkillOperation(deps, operation);
        return;
      }

      if (operation.kind === 'create-local-routine') {
        validateCreateLocalRoutineOperation(deps, operation);
        return;
      }

      const neverOperation: never = operation;
      throw new Error(`Unsupported onboarding operation: ${JSON.stringify(neverOperation)}`);
    },
    (error) => (error instanceof Error ? error.message : String(error)),
  );
}

function getVerificationFailureKind(itemId: string): OnboardingApplyOperation['kind'] {
  if (itemId.startsWith('agent-profile:')) return 'create-agent-profile';
  if (itemId.startsWith('selected-agent-profile:')) return 'select-agent-profile';
  if (itemId.startsWith('local-note:')) return 'create-local-note';
  if (itemId.startsWith('local-persona:')) return 'create-local-persona';
  if (itemId.startsWith('local-skill:')) return 'create-local-skill';
  if (itemId.startsWith('local-routine:')) return 'create-local-routine';
  return onboardingVerificationFailureKind(itemId);
}

export const { applyOnboardingRequest } = createOnboardingApplyPipeline<
  OnboardingApplyDependencies,
  OnboardingApplyOperation,
  OnboardingApplyRequest,
  OnboardingAppliedOperation
>({
  prevalidate: prevalidateApplyRequest,
  order: orderApplyOperations,
  rollbackFor: buildRollbackAction,
  rollback: runRollbacks,
  verify: verifyOnboardingRequest,
  verificationFailureKind: getVerificationFailureKind,
  describeError: (error) => (error instanceof Error ? error.message : String(error)),
  apply(deps, request, operation) {
    if (operation.kind === 'set-config') return applyConfigOperation(deps, operation);
    if (operation.kind === 'set-secret') return applySecretOperation(deps, operation);
    if (operation.kind === 'ensure-auth-user') {
      validateAuthOperation(deps, operation);
      return null;
    }
    if (operation.kind === 'acknowledge') return applyAcknowledgementOperation(deps, request, operation);
    if (operation.kind === 'create-agent-profile') return applyCreateAgentProfileOperation(deps, operation);
    if (operation.kind === 'select-agent-profile') return applySelectAgentProfileOperation(deps, operation);
    if (operation.kind === 'create-local-persona') return applyCreateLocalPersonaOperation(deps, operation);
    if (operation.kind === 'create-local-note') return applyCreateLocalNoteOperation(deps, operation);
    if (operation.kind === 'create-local-skill') return applyCreateLocalSkillOperation(deps, operation);
    if (operation.kind === 'create-local-routine') return applyCreateLocalRoutineOperation(deps, operation);
    const neverOperation: never = operation;
    throw new Error('Unsupported onboarding operation: ' + JSON.stringify(neverOperation));
  },
});

const {
  validateSecretOperation,
  applySecretOperation,
  buildSecretRollbackAction,
  validateAcknowledgementOperation,
  applyAcknowledgementOperation,
} = createOnboardingApplyPrimitives({ readOnboardingRuntimeState, writeOnboardingAcknowledgementState }, restoreFile);

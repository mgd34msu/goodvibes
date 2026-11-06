import { createOnboardingVerifier } from '@goodvibes-jev/engine/terminal-shell/onboarding-verification';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { readAgentRuntimeProfileSelection, resolveAgentRuntimeProfileHome } from '../../agent/runtime-profile.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { isFeatureEnabledInConfig, isLegacyFeatureConfigKey, legacyFeatureConfigTargets } from '../feature-enablement.ts';
import { readOnboardingRuntimeState } from './state.ts';
import type { OnboardingApplyOperation, OnboardingVerificationDependencies, OnboardingVerificationItem } from './types.ts';

function verifyLegacyConfig(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'set-config' }>,
): OnboardingVerificationItem | undefined {
  if (isLegacyFeatureConfigKey(operation.key)) {
    // Legacy featureFlags keys dissolved onto domain settings keys: verify the
    // DERIVED enablement of every addressed feature, not a category readback.
    const targets = legacyFeatureConfigTargets(operation.key, operation.value);
    const mismatched = targets.filter(
      (target) => (isFeatureEnabledInConfig(deps.config, target.featureId) ? 'enabled' : 'disabled') !== target.desired,
    );
    const ok = targets.length > 0 && mismatched.length === 0;
    return {
      id: `config:${operation.key}`,
      status: ok ? 'pass' : 'fail',
      message: ok
        ? `${operation.key} matches the requested onboarding value (derived from the domain settings keys).`
        : `${operation.key} does not match the requested onboarding value${
            mismatched.length > 0 ? ` (mismatched: ${mismatched.map((target) => target.featureId).join(', ')})` : ''
          }.`,
      target: operation.key,
    };
  }
  return undefined;
}

function verifyAuthOperation(
  _deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'ensure-auth-user' }>,
): OnboardingVerificationItem {
  const username = operation.username.trim();
  return {
    id: `auth:${username}`,
    status: 'fail',
    message: 'Runtime auth user/session administration is external to GoodVibes Agent onboarding.',
    target: username,
  };
}

function verifyCreateAgentProfileOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-agent-profile' }>,
): OnboardingVerificationItem {
  const resolution = resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, operation.name);
  const ok = existsSync(join(resolution.homeDirectory, 'profile.json'));
  return {
    id: `agent-profile:${resolution.id}`,
    status: ok ? 'pass' : 'fail',
    message: ok ? `${resolution.id} Agent profile exists.` : `${resolution.id} Agent profile was not created.`,
    target: resolution.id,
  };
}

function verifySelectAgentProfileOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'select-agent-profile' }>,
): OnboardingVerificationItem {
  const resolution = resolveAgentRuntimeProfileHome(deps.shellPaths.homeDirectory, operation.name);
  const selection = readAgentRuntimeProfileSelection(deps.shellPaths.homeDirectory);
  const ok = selection?.id === resolution.id && selection.exists;
  return {
    id: `selected-agent-profile:${resolution.id}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${resolution.id} Agent profile is selected for later plain goodvibes-agent runs.`
      : `${resolution.id} Agent profile is not selected for later plain goodvibes-agent runs.`,
    target: resolution.id,
  };
}

function verifyCreateLocalPersonaOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-persona' }>,
): OnboardingVerificationItem {
  const registry = AgentPersonaRegistry.fromShellPaths(deps.shellPaths);
  const persona = registry.get(operation.name);
  const activeOk = operation.activate === false || registry.snapshot().activePersonaId === persona?.id;
  const ok = persona !== null && activeOk;
  const target = persona?.id ?? operation.name.trim();
  return {
    id: `local-persona:${target}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${target} Agent-local persona exists${operation.activate === false ? '' : ' and is active'}.`
      : `${target} Agent-local persona was not created${operation.activate === false ? '' : ' or activated'}.`,
    target,
  };
}

function verifyCreateLocalSkillOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-skill' }>,
): OnboardingVerificationItem {
  const skill = AgentSkillRegistry.fromShellPaths(deps.shellPaths).get(operation.name);
  const enabledOk = operation.enabled === false || skill?.enabled === true;
  const ok = skill !== null && enabledOk;
  const target = skill?.id ?? operation.name.trim();
  return {
    id: `local-skill:${target}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${target} Agent-local skill exists${operation.enabled === false ? '' : ' and is enabled'}.`
      : `${target} Agent-local skill was not created${operation.enabled === false ? '' : ' or enabled'}.`,
    target,
  };
}

function verifyCreateLocalRoutineOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-routine' }>,
): OnboardingVerificationItem {
  const routine = AgentRoutineRegistry.fromShellPaths(deps.shellPaths).get(operation.name);
  const enabledOk = operation.enabled === false || routine?.enabled === true;
  const ok = routine !== null && enabledOk;
  const target = routine?.id ?? operation.name.trim();
  return {
    id: `local-routine:${target}`,
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${target} Agent-local routine exists${operation.enabled === false ? '' : ' and is enabled'}.`
      : `${target} Agent-local routine was not created${operation.enabled === false ? '' : ' or enabled'}.`,
    target,
  };
}

function verifyCreateLocalNoteOperation(
  deps: OnboardingVerificationDependencies,
  operation: Extract<OnboardingApplyOperation, { kind: 'create-local-note' }>,
): OnboardingVerificationItem {
  const note = AgentNoteRegistry.fromShellPaths(deps.shellPaths).get(operation.title);
  const ok = note !== null && note.body.trim() === operation.body.trim();
  const target = note?.id ?? operation.title.trim();
  return {
    id: `local-note:${target}`,
    status: ok ? 'pass' : 'fail',
    message: ok ? `${target} Agent-local note exists.` : `${target} Agent-local note was not created.`,
    target,
  };
}

async function verifyExtraOperation(
  deps: OnboardingVerificationDependencies,
  operation: AgentVerificationOperation,
): Promise<OnboardingVerificationItem> {
  if (operation.kind === 'ensure-auth-user') return verifyAuthOperation(deps, operation);
  if (operation.kind === 'create-agent-profile') return verifyCreateAgentProfileOperation(deps, operation);
  if (operation.kind === 'select-agent-profile') return verifySelectAgentProfileOperation(deps, operation);
  if (operation.kind === 'create-local-note') return verifyCreateLocalNoteOperation(deps, operation);
  if (operation.kind === 'create-local-persona') return verifyCreateLocalPersonaOperation(deps, operation);
  if (operation.kind === 'create-local-skill') return verifyCreateLocalSkillOperation(deps, operation);
  return verifyCreateLocalRoutineOperation(deps, operation);
}

type AgentVerificationOperation = Exclude<OnboardingApplyOperation, { kind: 'set-config' | 'set-secret' | 'acknowledge' }>;
type VerificationConfigKey = Extract<OnboardingApplyOperation, { kind: 'set-config' }>['key'];
export const verifyOnboardingRequest = createOnboardingVerifier<
  VerificationConfigKey,
  OnboardingVerificationDependencies,
  OnboardingApplyOperation,
  AgentVerificationOperation
>({
  readState: readOnboardingRuntimeState,
  select: (operation) =>
    operation.kind === 'set-config' || operation.kind === 'set-secret' || operation.kind === 'acknowledge'
      ? operation
      : { kind: 'extension', operation },
  verifyConfig: verifyLegacyConfig,
  verifyExtra: verifyExtraOperation,
});

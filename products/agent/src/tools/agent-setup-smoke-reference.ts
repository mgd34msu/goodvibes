import type { ArtifactCreateInput, ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import { judgmentInputCardProblem, snapshotJudgmentInput } from '@goodvibes/engine/platform/platform/gate/judgment-input';
import { assertCurrentToolEffect, assertProjectionExecution, ToolInputProjectionError, type ToolInputProjector, type ToolNativeReferencesCapture } from '@goodvibes/engine/platform/platform/tools';
import type { Tool } from '@goodvibes/engine/platform/platform/types';
import { containsIssuerCredential } from '@goodvibes/engine/platform/platform/utils';
import type { CommandContext } from '../input/command-registry.ts';
import { SETUP_SMOKE_EVIDENCE_FIELD_DEFINITIONS, redactSetupSmokeEvidence, redactSetupSmokeEvidenceFull } from './agent-harness-setup-smoke.ts';
import type { SetupSmokeArtifactStore, SetupSmokeEvidenceField } from './agent-harness-setup-posture-types.ts';

type ExecutionOptions = Parameters<Tool['execute']>[1];
interface Capture {
  readonly evidence: readonly SetupSmokeEvidenceField[];
  readonly store: SetupSmokeArtifactStore | undefined;
  released: boolean;
}
const captures = new WeakMap<object, Capture>();

/** Safe text remains complete; redaction markers carry no replaced value. */
function evidenceParts(text: string): readonly Record<string, string>[] {
  const parts: Record<string, string>[] = [];
  const markers = /<redacted>|\[REDACTED(?:_[A-Z_]+)?\]/g;
  let cursor = 0;
  for (const match of text.matchAll(markers)) {
    if (match.index > cursor) parts.push({ kind: 'text', text: text.slice(cursor, match.index) });
    parts.push({ kind: 'redacted', marker: match[0] });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
  return parts;
}

/**
 * The one capture of pasted setup smoke output, on the tool call that saves it
 * (`setup action:"smoke"` or `agent_harness mode:"run_setup_smoke"`). It runs
 * before ordinary argument capture: the pasted text is redacted once, card and
 * issuer-credential material is refused, the approver is shown the redacted
 * text, and only placeholders stay in the arguments. The artifact store owns
 * the path it writes to.
 */
export function createSetupSmokeReferenceCapture(context?: CommandContext,
  selectSetupSmoke?: (args: Readonly<Record<string, unknown>>) => boolean): NonNullable<ToolInputProjector['captureNativeReferences']> {
  const name = selectSetupSmoke ? 'setup' : 'agent_harness';
  return request => {
    if (request.name !== name || !context) return undefined;
    if (selectSetupSmoke ? !selectSetupSmoke(request.args) : request.args.mode !== 'run_setup_smoke') return undefined;
    if (!selectSetupSmoke && request.args.setupItemId !== undefined && request.args.setupItemId !== 'install-smoke') return undefined;
    const fields = request.args.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined;
    const rawFields = fields as Readonly<Record<string, unknown>>;
    const selected = SETUP_SMOKE_EVIDENCE_FIELD_DEFINITIONS.filter(field => typeof rawFields[field.id] === 'string');
    if (!selected.length) return undefined;
    const signal = request.signal;
    request.assertCurrent(); signal?.throwIfAborted();
    // The whole pasted text is inspected, including content past the saved cut.
    if (judgmentInputCardProblem(request.args, request.name)) throw new ToolInputProjectionError('held');
    const safeFields = { ...rawFields };
    const evidence: SetupSmokeEvidenceField[] = [];
    const subjects = selected.map(definition => {
      const raw = rawFields[definition.id] as string;
      const cleared = redactSetupSmokeEvidenceFull(raw.trim());
      if (containsIssuerCredential(cleared)) throw new ToolInputProjectionError('held');
      safeFields[definition.id] = `native-smoke:${definition.id}`;
      // The saved value says when it was cut; the parts shown to the approver stay complete.
      if (cleared) evidence.push(Object.freeze({ ...definition, value: redactSetupSmokeEvidence(raw.trim()) }));
      return { id: definition.id, label: definition.label, parts: evidenceParts(cleared) };
    });
    const safeArgs = { ...request.args, fields: safeFields, nativeReferenceSubjects: {
      kind: 'setup-smoke-evidence', purpose: 'Save redacted user-run setup smoke evidence as a local artifact.', evidence: subjects,
    } };
    // The safe text and every other caller field still cross the ordinary credential and card floor.
    snapshotJudgmentInput(safeArgs, request.name);
    const token = Object.freeze({});
    const store = (context.platform as { readonly artifactStore?: SetupSmokeArtifactStore }).artifactStore;
    const capture: Capture = { evidence: Object.freeze(evidence), store, released: false };
    const assertCurrent = () => { signal?.throwIfAborted(); if (capture.released) throw new ToolInputProjectionError('stale'); };
    captures.set(token, capture);
    const retire = () => { capture.released = true; captures.delete(token); };
    signal?.addEventListener('abort', retire, { once: true });
    const release = async () => { signal?.removeEventListener('abort', retire); retire(); };
    return { args: safeArgs, fields: [], paths: selected.map(field => ['fields', field.id]),
      assertCurrent, executionContext: token, release } satisfies ToolNativeReferencesCapture;
  };
}

export interface SetupSmokeNativeEvidence {
  readonly fields: readonly SetupSmokeEvidenceField[];
  readonly assertCurrent: () => void;
  readonly createArtifact: ((input: ArtifactCreateInput) => Promise<ArtifactDescriptor>) | undefined;
}

/**
 * The redacted evidence of this call's capture. Saving one local artifact is a
 * write: the call's own gate admission for `write` is the authority.
 */
export function resolveSetupSmokeNativeEvidence(args: Record<string, unknown>, options: ExecutionOptions, _context?: CommandContext): SetupSmokeNativeEvidence {
  const token = options?.inputProjectionContext;
  const capture = token ? captures.get(token) : undefined;
  const assertCurrent = () => {
    options?.signal?.throwIfAborted();
    if (!assertCurrentToolEffect(args, options, 'write')) throw new ToolInputProjectionError('held');
    if (capture && token) { assertProjectionExecution(token, args); if (capture.released) throw new ToolInputProjectionError('stale'); }
  };
  assertCurrent();
  if (!capture) {
    // Fields that name no known evidence id, or carry a non-string value, are the caller's mistake.
    if (args.fields && Object.keys(args.fields as object).length) {
      const given = args.fields as Readonly<Record<string, unknown>>;
      const usable = SETUP_SMOKE_EVIDENCE_FIELD_DEFINITIONS.some(field => typeof given[field.id] === 'string');
      throw new ToolInputProjectionError(usable ? 'held' : 'invalid');
    }
    return { fields: [], assertCurrent, createArtifact: undefined };
  }
  const store = capture.store, create = store?.create;
  return { fields: capture.evidence, assertCurrent, createArtifact: create
    ? async input => { assertCurrent(); return create.call(store, input, { signal: options?.signal }); } : undefined };
}

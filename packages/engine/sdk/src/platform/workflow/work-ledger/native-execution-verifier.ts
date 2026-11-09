/** Host-only original-source checks. A terminal runner is never its own attestation. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { hashState, readYesNo, type YesNoBand, type DecisionLog, type EntryType, type JudgmentPort } from '@goodvibes-jev/judgment';
import { assertDurableCheckpoint, parseDurableAdmission } from '../../contract/durable-admission.js';
import { assertNativeContractSource, nativeContractSourceForAdmission } from '../../contract/native-source.js';
import { UNIT_JUDGE_BANDS } from '../../contract/batteries/unit-judge.js';
import { FINAL_ANSWER_REVIEWS } from '../../contract/batteries/final-answer-review.js';
import { ORIGINAL_OBLIGATION_COVERAGE, originalObligationSource } from '../../contract/batteries/original-obligation-coverage.js';
import { captureAnswerClaimOutput, completeAnswerClaimCoverage, scopedClaimQuestion, type AnswerClaimReview, type AnswerClaimOutput } from '../../contract/final-answer-claims.js';
import { GOAL_OBLIGATIONS } from '../../contract/batteries/goal-obligations.js';
import { goalObligationSource, goalObligationQuestion } from '../../contract/goal-obligation-proof.js';
import { UNIT_QUALITY_BAND } from '../../contract/batteries/unit-quality.js';
import { CHECK_SITES, runUnitCheck, type CheckSettings } from '../../contract/check.js';
import { judgeState, qualityState, trimEvidence, type FileChange } from '../../contract/evidence.js';
import { QUALITY_ITEMS, type ContractUnit, type ContractView } from '../../contract/types.js';
import type { ContractRunner } from '../../contract/runner.js';
import type { ReadAccessFilter } from '../../tools/shared/read-access.js';
import { emptyWorkItemUsage } from '../../orchestration/types.js';
import { parseNativeWorkExecutionRecord, type NativeWorkExecutionRecord } from './native-execution-types.js';
import type { WorkEvidenceReference } from './types.js';
import { nativeJudgeBatches, nativeQuestionBatches } from './native-judge-proof.js';
import { nativeSettlementDigest, type NativeWorkAttestation } from './native-settlement-types.js';
export type { NativeWorkAttestation } from './native-settlement-types.js';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function contained(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error('Native artifact path must be relative');
  const absolute = resolve(root, path); const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Native artifact escapes its execution tree');
  // A genuine deletion may remove its containing directory too. Check the
  // nearest surviving parent without following a dangling or linked ancestor.
  let parent = dirname(absolute);
  for (;;) {
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(parent) !== parent) throw new Error('Native artifact has a linked parent');
      const relParent = relative(root, parent);
      if (relParent === '..' || relParent.startsWith('../') || isAbsolute(relParent)) throw new Error('Native artifact parent escapes its execution tree');
      return absolute;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === root) throw error;
      parent = dirname(parent);
    }
  }
}
/** Terminal worktree completion can evict its tree only after applying the result. */
function evidenceRoot(contract: ContractView): string {
  if (contract.commit?.status === 'failed') throw new Error('Native deliverable was not applied or committed');
  if (contract.isolation === 'worktree' && contract.sessionMode !== true) {
    if (!contract.commit || !['applied', 'committed', 'skipped'].includes(contract.commit.status)) throw new Error('Native worktree application is unavailable');
    // A skipped application is safe only for output-only work. No branch-only file proves owner-tree completion.
    if (contract.commit.status === 'skipped' && contract.units.some(unit => unit.touchedPaths.length > 0)) throw new Error('Native changed artifacts were not applied');
  }
  return realpathSync(contract.projectRoot);
}
type ArtifactSnapshot =
  | { readonly kind: 'absent'; readonly text: string; readonly byteLength: 0 }
  | { readonly kind: 'file'; readonly bytes: Buffer; readonly text: string; readonly byteLength: number };
const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
function readArtifact(root: string, path: string): ArtifactSnapshot {
  const absolute = contained(root, path);
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ARTIFACT_MAX_BYTES) throw new Error('Native artifact must be a bounded regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent', text: '(deleted file)', byteLength: 0 };
    throw error;
  }
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true }); const named = lstatSync(contained(root, path), { bigint: true });
    if (!before.isFile() || !named.isFile() || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino || before.size > BigInt(ARTIFACT_MAX_BYTES)) throw new Error('Native artifact changed before capture');
    // A file growing during a read must not allocate beyond the admitted size.
    const buffer = Buffer.alloc(Number(before.size) + 1); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(contained(root, path), { bigint: true });
    if (offset !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || !current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino
      || current.size !== after.size || current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) throw new Error('Native artifact changed during capture');
    const bytes = buffer.subarray(0, offset);
    return { kind: 'file', bytes, byteLength: bytes.length, text: bytes.includes(0) ? `(binary file, ${bytes.length} bytes)` : bytes.toString('utf8') };
  } finally { closeSync(fd); }
}
function sameArtifact(left: ArtifactSnapshot, right: ArtifactSnapshot): boolean {
  return left.kind === 'file' ? right.kind === 'file' && left.bytes.equals(right.bytes) : right.kind === 'absent';
}

export interface VerifiedNativeWorkExecution {
  readonly attestation: NativeWorkAttestation;
  readonly report: string;
  readonly contractDigest: string;
  /** Synchronous last guard for the exact frozen proof, including host-read bytes. */
  assertCurrent(): void;
}
/** Captures before joining, never resumes execution, and owns no availability retry loop. */
export async function verifyNativeWorkExecution(options: {
  readonly execution: NativeWorkExecutionRecord;
  readonly runner: Pick<ContractRunner, 'get' | 'join'>;
  readonly port: JudgmentPort;
  readonly decisionLog: Pick<DecisionLog, 'get'>;
  readonly settings: CheckSettings;
  readonly readAccessFilter: ReadAccessFilter;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
  readonly now?: () => number;
}): Promise<VerifiedNativeWorkExecution> {
  // Parse a detached record before any borrowed hook. No original mutable requirement survives.
  const record = parseNativeWorkExecutionRecord(options.execution);
  const settings = freeze(structuredClone(options.settings));
  if (!record.receipt || record.state !== 'launch-claimed') throw new Error('Native execution has no claimed durable receipt');
  const admission = parseDurableAdmission({ ...record.receipt, input: record.request.input }, record.request);
  const source = record.request.input.nativeSource!;
  const current = () => { options.signal.throwIfAborted(); options.assertCurrent(); options.signal.throwIfAborted(); };
  current(); await options.runner.join(admission.contractId); current();
  const raw = options.runner.get(admission.contractId);
  if (!raw) throw new Error('Native runner checkpoint is unavailable');
  const contract = freeze(structuredClone(raw));
  // One exact immutable answer is compared with several saved receipt/question
  // bindings. Reuse its commitment within this verification; never re-hash the
  // entire answer per claim or carry it into another verification lifetime.
  let retainedAnswerOutput: AnswerClaimOutput | undefined;
  const answerOutput = (): AnswerClaimOutput => retainedAnswerOutput ??= captureAnswerClaimOutput(contract.answer ?? '');
  const answerCommitment = (): string => answerOutput().digest;
  assertDurableCheckpoint(contract, admission); assertNativeContractSource(contract);
  if (contract.status !== 'passed') throw new Error('Native verifier requires the bound passed contract');
  const contractDigest = nativeSettlementDigest(contract);
  const units = contract.units.flatMap(unit => unit.attemptUnits?.length ? unit.attemptUnits.filter(attempt => attempt.status === 'passed') : [unit]);
  const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const rawNo = (value: unknown, band: YesNoBand): number | null => {
    const answer = object(value); const probability = answer?.['noul'];
    if (answer?.['type'] !== 'noul' || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) return null;
    const reading = readYesNo({ type: 'noul', noul: probability }, band);
    return reading.verdict === 'no' && reading.outcome === 'act' ? probability : null;
  };
  function priorJudge(check: ContractView['checks'][number], criteria: ContractView['criteria'], site: string, ids = check.decisionIds.slice(0, 1)): boolean {
    const readings = nativeJudgeBatches(ids, criteria, site, options.decisionLog);
    if (!readings) return false;
    const originalGoal = readings.get('goal')!.answer;
    const goal = rawNo(originalGoal, UNIT_JUDGE_BANDS.high);
    if (goal === null || goal !== check.goal.probabilityUnmet) {
      if (site !== 'contract.check.deliverable-judge' || !genuineGoalProof(check, ids, originalGoal.noul)) return false;
    }
    return criteria.filter(criterion => criterion.disposition === 'judged').every((criterion, index) => {
      const source = readings.get(`criterion_${index}`)!;
      const raw = rawNo(source.answer, UNIT_JUDGE_BANDS.high);
      const reading = criterion.readings.find(value => value.checkId === check.id && value.decisionId === source.decisionId);
      return raw !== null && reading?.probabilityUnmet === raw && reading.verdict === 'met' && reading.outcome === 'act';
    });
  }
  function genuineGoalProof(check: ContractView['checks'][number], sourceIds: readonly string[], sourceProbability: number): boolean {
    const decision = [...contract.decisions].reverse().find(value => value.action === 'checked' && value.targetId === `${contract.id}.goal-obligations`
      && value.decisionIds.every(id => check.decisionIds.includes(id)));
    let proof: Record<string, unknown> | null = null;
    try { proof = decision ? object(JSON.parse(decision.reason)) : null; } catch { return false; }
    const ids = proof?.['decisionIds'];
    if (!decision || proof?.['schemaVersion'] !== 1 || proof['passed'] !== true || !Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string'
      || !contract.criteria.some(criterion => criterion.disposition === 'judged')
      || !contract.criteria.filter(criterion => criterion.disposition === 'met-by-structure').every(criterion => criterion.status === 'met')) return false;
    const entry = options.decisionLog.get(ids[0]);
    const battery = entry?.context.battery === GOAL_OBLIGATIONS.critical.name ? GOAL_OBLIGATIONS.critical : GOAL_OBLIGATIONS.high;
    const source = nativeQuestionBatches(ids, ['omitted'], 'contract.check.goal-obligations', options.decisionLog)?.get('omitted');
    const literalSourceDigest = hashState(goalObligationSource(contract));
    const initial = readYesNo({ type: 'noul', noul: sourceProbability }, UNIT_JUDGE_BANDS.high);
    const recordedInitial = object(proof['sourceGoal']), recorded = object(proof['reading']), policy = object(proof['policy']);
    if (!source || !entry || entry.context.battery !== battery.name || entry.context.batteryVersion !== battery.version
      || entry.stateHash !== proof['stateHash'] || proof['literalSourceDigest'] !== literalSourceDigest || proof['outputDigest'] !== answerCommitment()
      || !isDeepStrictEqual(proof['sourceJudgmentDecisionIds'], sourceIds)
      || !isDeepStrictEqual(decision.decisionIds, ids)
      || !isDeepStrictEqual(source.question, goalObligationQuestion(battery.items.omitted.question, literalSourceDigest))
      || sourceProbability <= 0.5 || initial.outcome === 'act' || recordedInitial?.['probability'] !== sourceProbability
      || recordedInitial['verdict'] !== initial.verdict || recordedInitial['outcome'] !== initial.outcome
      || policy?.['name'] !== battery.name || policy['version'] !== battery.version) return false;
    const probability = rawNo(source.answer, battery.items.omitted.band);
    const actualPremises = nativeJudgeBatches(sourceIds, contract.criteria, 'contract.check.deliverable-judge', options.decisionLog);
    const worstPremise = actualPremises ? Math.max(...contract.criteria.filter(criterion => criterion.disposition === 'judged')
      .map((_, index) => actualPremises.get(`criterion_${index}`)!.answer.noul)) : Infinity;
    return probability !== null && recorded?.['probability'] === probability && recorded['verdict'] === 'no' && recorded['outcome'] === 'act'
      && check.goal.probabilityUnmet === Math.max(probability, worstPremise) && check.goal.verdict === 'met' && check.goal.outcome === 'act';
  }
  function genuine(unit: ContractView['units'][number]): boolean {
    const check = unit.checks.at(-1);
    if (!check || check.result !== 'pass' || check.goal.verdict !== 'met' || check.goal.outcome !== 'act' || check.decisionIds.length !== 2
      || !priorJudge(check, unit.criteria, CHECK_SITES.judge)) return false;
    const quality = options.decisionLog.get(check.decisionIds[1]!);
    if (!quality || quality.status !== 'answered' || quality.context.site !== CHECK_SITES.quality) return false;
    const answers = object(quality.answers);
    return !!answers && Object.keys(answers).length === QUALITY_ITEMS.length && QUALITY_ITEMS.every(item => rawNo(answers[item], UNIT_QUALITY_BAND) !== null
      && check.quality[item]?.verdict === 'no' && check.quality[item]?.outcome === 'act');
  }
  if (units.length === 0 || units.some(unit => unit.status !== 'passed' || !genuine(unit))) throw new Error('Native execution lacks genuine unit and quality checks');
  const deliverable = contract.checks.at(-1);
  const deliverableSite = 'contract.check.deliverable-judge';
  const judgeGroups = new Map<string, string[]>();
  for (const id of deliverable?.decisionIds ?? []) {
    const entry = options.decisionLog.get(id);
    if (entry?.status !== 'answered' || entry.context.site !== deliverableSite) continue;
    const ids = judgeGroups.get(entry.stateHash) ?? [];
    ids.push(id); judgeGroups.set(entry.stateHash, ids);
  }
  const deliverableJudgeIds = deliverable ? [...judgeGroups.values()].find(ids => priorJudge(deliverable, contract.criteria, deliverableSite, ids)) : undefined;
  if (!deliverable || deliverable.result !== 'pass' || deliverable.goal.verdict !== 'met' || deliverable.goal.outcome !== 'act'
    || !deliverableJudgeIds) throw new Error('Native execution lacks a genuine deliverable check');
  // The independent content review is part of completion, not an extra ID that
  // makes an otherwise genuine requirements check invalid. Verify its actual
  // recorded answers and input binding; a checkpoint's passed label is no proof.
  const contentDecision = [...contract.decisions].reverse().find(decision => decision.action === 'checked'
    && decision.targetId === `${contract.id}.final-answer-review`
    && decision.decisionIds.every(id => deliverable.decisionIds.includes(id)));
  let content: Record<string, unknown> | null = null;
  try { content = contentDecision ? object(JSON.parse(contentDecision.reason)) : null; } catch { /* Missing valid evidence fails below. */ }
  const contentIds = content?.['decisionIds'];
  const fulfillmentIds = content?.['fulfillmentDecisionIds'];
  const claims = content?.['claimReviews'];
  const claimIds = Array.isArray(claims) ? claims.map(value => object(value)?.['decisionId']) : [];
  const overviewIds = Array.isArray(contentIds) ? contentIds.filter(id => !claimIds.includes(id)) : [];
  const contentEntries = Array.isArray(contentIds) && contentIds.every(id => typeof id === 'string')
    ? overviewIds.map(id => options.decisionLog.get(id)) : [];
  const contentReadings = object(content?.['readings']);
  const contentQuestions = Array.isArray(contentIds) && contentIds.every(id => typeof id === 'string')
    ? nativeQuestionBatches(overviewIds, ['unfinished', 'unsupported'], 'contract.check.final-answer-review', options.decisionLog) : null;
  const battery = contentEntries[0]?.context.battery === FINAL_ANSWER_REVIEWS.critical.name ? FINAL_ANSWER_REVIEWS.critical : FINAL_ANSWER_REVIEWS.high;
  function genuineClaims(): boolean {
    if (!Array.isArray(claims) || !claims.length || new Set(claimIds).size !== claimIds.length
      || !Array.isArray(contentIds) || !claimIds.every(id => typeof id === 'string' && contentIds.includes(id))
      || !completeAnswerClaimCoverage(contract.answer ?? '', claims as AnswerClaimReview[], answerOutput())) return false;
    const overview = object(content?.['overviewUnsupported']);
    const overviewQuestion = contentQuestions?.get('unsupported');
    const rawOverview = overviewQuestion?.answer.noul;
    if (typeof rawOverview !== 'number' || rawOverview <= 0.5 || overview?.['probability'] !== rawOverview
      || !isDeepStrictEqual(overviewQuestion?.question, battery.items.unsupported.question)
      || readYesNo({ type: 'noul', noul: rawOverview }, battery.items.unsupported.band).outcome === 'act') return false;
    let worst = -1;
    for (const rawClaim of claims) {
      const claim = object(rawClaim)!, reading = object(claim['reading']);
      const id = claim['decisionId'] as string;
      const entry = options.decisionLog.get(id);
      const actual = nativeQuestionBatches([id], ['unsupported'], 'contract.check.final-answer-review', options.decisionLog)?.get('unsupported');
      if (!actual || !entry || entry.context.battery !== battery.name || entry.context.batteryVersion !== battery.version
        || entry.stateHash !== claim['stateHash'] || entry.stateHash === content?.['stateHash']
        || !isDeepStrictEqual(actual.question, scopedClaimQuestion(battery.items.unsupported.question,
          rawClaim as AnswerClaimReview, answerCommitment()))) return false;
      const raw = rawNo(actual.answer, battery.items.unsupported.band);
      if (raw === null || reading?.['probability'] !== raw || reading['verdict'] !== 'no' || reading['outcome'] !== 'act') return false;
      worst = Math.max(worst, raw);
    }
    const effective = object(contentReadings?.['unsupported']);
    return effective?.['probability'] === worst && effective['verdict'] === 'no' && effective['outcome'] === 'act';
  }
  const goalDecision = [...contract.decisions].reverse().find(decision => decision.action === 'checked' && decision.targetId === `${contract.id}.goal-obligations`
    && decision.decisionIds.every(id => deliverable.decisionIds.includes(id)));
  const directGoal = nativeJudgeBatches(deliverableJudgeIds, contract.criteria, deliverableSite, options.decisionLog)?.get('goal');
  const qualifiedGoalIds = directGoal && rawNo(directGoal.answer, UNIT_JUDGE_BANDS.high) === deliverable.goal.probabilityUnmet ? [] : goalDecision?.decisionIds ?? [];
  const originalDecision = [...contract.decisions].reverse().find(decision => decision.action === 'checked'
    && decision.targetId === `${contract.id}.original-obligations`);
  let original: Record<string, unknown> | null = null;
  try { original = originalDecision ? object(JSON.parse(originalDecision.reason)) : null; } catch { /* Invalid evidence fails below. */ }
  const originalIds = original?.['decisionIds'];
  const originalId = Array.isArray(originalIds) && originalIds.length === 1 && typeof originalIds[0] === 'string' ? originalIds[0] : undefined;
  const originalEntry = originalId ? options.decisionLog.get(originalId) : undefined;
  const originalBattery = originalEntry?.context.battery === ORIGINAL_OBLIGATION_COVERAGE.critical.name
    ? ORIGINAL_OBLIGATION_COVERAGE.critical : ORIGINAL_OBLIGATION_COVERAGE.high;
  const originalQuestion = originalId ? nativeQuestionBatches([originalId], ['original_obligations_unmet'],
    'contract.check.original-obligation-coverage', options.decisionLog)?.get('original_obligations_unmet') : undefined;
  const originalProbability = originalQuestion ? rawNo(originalQuestion.answer, originalBattery.items.original_obligations_unmet.band) : null;
  const originalReading = object(original?.['reading']);
  const originalPolicy = object(original?.['policy']);
  // The v1 evidenceDigest was only a presence check, not an independent
  // verification. Read actual older receipts; fresh v2 relies on the genuine
  // recorded complete input plus the separately verified source/output binds.
  const originalVersionValid = original?.['schemaVersion'] === 1 ? typeof original['evidenceDigest'] === 'string'
    : original?.['schemaVersion'] === 2 && !Object.hasOwn(original, 'evidenceDigest');
  if (!original || !originalVersionValid || original['passed'] !== true || !originalId || !originalEntry
    || originalEntry.status !== 'answered' || originalEntry.context.battery !== originalBattery.name
    || originalEntry.context.batteryVersion !== originalBattery.version || originalEntry.stateHash !== original['stateHash']
    || originalPolicy?.['name'] !== originalBattery.name || originalPolicy['version'] !== originalBattery.version
    || original['sourceDigest'] !== hashState(originalObligationSource(contract)) || original['outputDigest'] !== answerCommitment()
    || !originalQuestion || originalProbability === null
    || originalReading?.['probability'] !== originalProbability || originalReading['verdict'] !== 'no' || originalReading['outcome'] !== 'act'
    || !isDeepStrictEqual(originalQuestion.question, originalBattery.items.original_obligations_unmet.question)
    || !isDeepStrictEqual(originalDecision?.decisionIds, originalIds)
    || !deliverable.decisionIds.includes(originalId)) {
    throw new Error('Native execution lacks genuine original-obligation coverage');
  }
  let claimsValid: boolean | undefined;
  const genuineClaimsOnce = (): boolean => claimsValid ??= genuineClaims();
  const expectedIds = Array.isArray(fulfillmentIds) ? [...new Set([...fulfillmentIds, ...(Array.isArray(contentIds) ? contentIds : []), ...deliverableJudgeIds, ...qualifiedGoalIds, originalId])] : [];
  if (content?.['schemaVersion'] !== 2 || content['passed'] !== true || content['outputDigest'] !== answerCommitment()
    || !contentQuestions || !contentReadings || !contentEntries.length
    || (claims !== undefined && !genuineClaimsOnce())
    || !Array.isArray(contentIds) || new Set(contentIds).size !== contentIds.length
    || !contentEntries.every(entry => entry?.status === 'answered' && entry.context.battery === battery.name
      && entry.context.batteryVersion === battery.version && entry.stateHash === content['stateHash'])
    || !['unfinished', 'unsupported'].every(key => {
      const reading = object(contentReadings[key]); const item = battery.items[key as 'unfinished' | 'unsupported'];
      const source = contentQuestions.get(key)!;
      if (key === 'unsupported' && claims !== undefined) return genuineClaimsOnce();
      const raw = rawNo(source.answer, item.band);
      return raw !== null && reading?.['probability'] === raw && reading['verdict'] === 'no' && reading['outcome'] === 'act'
        && isDeepStrictEqual(source.question, item.question);
    }) || !Array.isArray(fulfillmentIds) || !fulfillmentIds.every(id => typeof id === 'string')
    || !nativeJudgeBatches(fulfillmentIds, contract.criteria, deliverableSite, options.decisionLog)
    || !contentDecision || !isDeepStrictEqual(contentDecision.decisionIds, contentIds)
    || deliverable.decisionIds.length !== expectedIds.length || !expectedIds.every(id => typeof id === 'string' && deliverable.decisionIds.includes(id))) {
    throw new Error('Native execution lacks a genuine final-answer content review');
  }
  const root = evidenceRoot(contract);
  const paths = [...new Set(contract.units.flatMap(unit => unit.touchedPaths))];
  if (paths.length > 94) throw new Error('Native evidence exceeds ledger reference capacity');
  const captured: (ArtifactSnapshot & { readonly path: string; readonly digest: string })[] = [];
  let bytes = 0;
  for (const path of paths) {
    current(); const absolute = contained(root, path);
    if (!await options.readAccessFilter(absolute)) throw new Error('Native artifact read is access-restricted');
    current(); const content = readArtifact(root, path); bytes += content.byteLength;
    if (bytes > 20 * 1024 * 1024) throw new Error('Native artifact capture exceeds total budget');
    const artifactDigest = content.kind === 'file'
      ? nativeSettlementDigest({ kind: 'file', sha256: digest(content.bytes) }) : digest('native-artifact:absent');
    captured.push({ path, ...content, digest: artifactDigest });
  }
  const assertCurrent = () => {
    current(); const latest = options.runner.get(admission.contractId);
    if (!latest || !isDeepStrictEqual(latest, contract) || evidenceRoot(latest) !== root) throw new Error('Native contract changed during verification');
    for (const artifact of captured) if (!sameArtifact(readArtifact(root, artifact.path), artifact)) throw new Error('Native artifact changed during verification');
    current();
  };
  assertCurrent();
  const unit: ContractUnit = { id: 'native', groupId: 'native', title: 'Frozen native acceptance', goal: source.goal, brief: source.goal,
    role: 'research', dependsOn: [], files: [], attempts: 1,
    criteria: source.criteria.map((text, index) => ({ id: `native.c${index}`, text, quote: text, origin: 'stated', serves: [], disposition: 'judged', status: 'unread', readings: [] })),
    status: 'checking', agentIds: [], checks: [], nudges: [], fixRounds: 0, freshAgents: 0, transportRetries: 0, touchedPaths: [], usage: emptyWorkItemUsage() };
  // Only authorized, contained, host-read artifacts enter the prompt. No broad git diff can disclose unrelated files.
  const changes: FileChange[] = captured.map(item => ({ path: item.path, diff: `${item.path}\n${item.text}` }));
  const evidence = freeze(trimEvidence({ output: contract.answer ?? '', changes, gates: deliverable!.gates, commands: [] }, unit));
  const originalSource = nativeContractSourceForAdmission(contract);
  const states = new Map<string, { hash: string; questions: unknown; answers: unknown; decisionId?: string }>();
  const checkAbort = new AbortController(); const checkSignal = AbortSignal.any([options.signal, checkAbort.signal]);
  const pending = new Set<Promise<unknown>>();
  const checkPort: JudgmentPort = { ...options.port, ask(request) {
    const operation = Promise.resolve().then(async () => {
      const active = () => { checkSignal.throwIfAborted(); assertCurrent(); request.signal?.throwIfAborted(); request.beforeAttempt?.(); assertCurrent(); checkSignal.throwIfAborted(); };
      const state = freeze(structuredClone({ ...(request.state as Record<string, EntryType>), originalSource })) as unknown as EntryType;
      const questions = freeze(structuredClone(request.questions));
      const site = request.context?.site;
      if (!site || (site !== CHECK_SITES.judge && site !== CHECK_SITES.quality)) throw new Error('Unexpected native settlement decision site');
      const captured = { hash: hashState(state), questions };
      // Forward the registered runUnitCheck request with detached images. This
      // adapter defines no questions or decision; the generic request type stays intact.
      const forwarded: typeof request = { ...request, state, questions, signal: checkSignal, beforeAttempt: active };
      active();
      // The shared port lends an object. Snapshot before borrowed guards or a
      // later microtask can change what the battery reads after provenance capture.
      const result = freeze(structuredClone(await options.port.ask(forwarded)));
      active();
      states.set(site, { ...captured, answers: result.answers, ...(result.decisionId ? { decisionId: result.decisionId } : {}) }); return result;
    });
    pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation)); return operation;
  } };
  let result: Awaited<ReturnType<typeof runUnitCheck>>;
  try {
    result = await runUnitCheck({ contract, unit, evidence, trigger: 'completion', settings, now: options.now?.() ?? Date.now(), signal: checkSignal, checkPort });
  } catch (error) {
    checkAbort.abort(); await Promise.allSettled([...pending]); throw error;
  }
  assertCurrent(); if (result.discarded) throw new Error('Native verification cancelled');
  for (const path of paths) { if (!await options.readAccessFilter(contained(root, path))) throw new Error('Native artifact read was revoked'); assertCurrent(); }
  const decisionReferences = result.check.decisionIds.map((id, index): WorkEvidenceReference => {
    const entry = options.decisionLog.get(id); const site = index === 0 ? CHECK_SITES.judge : CHECK_SITES.quality;
    const expected = hashState({ ...(index === 0 ? judgeState(unit, evidence) : qualityState(unit, evidence)), originalSource } as unknown as EntryType);
    if (!entry || entry.status !== 'answered' || entry.context.site !== site || entry.stateHash !== expected || states.get(site)?.hash !== expected || states.get(site)?.decisionId !== id || !isDeepStrictEqual(states.get(site)?.questions, entry.questions) || !isDeepStrictEqual(states.get(site)?.answers, entry.answers)) throw new Error('Native decision provenance is missing or mismatched');
    const { notes: _notes, ...immutable } = entry;
    return { kind: 'decision', ref: `decision:${id}`, digest: nativeSettlementDigest(immutable) };
  });
  if (decisionReferences.length !== 2 || new Set(result.check.decisionIds).size !== 2) throw new Error('Native settlement requires both recorded decision batteries');
  const references: WorkEvidenceReference[] = [...decisionReferences,
    { kind: 'test', ref: `check:${contract.id}:${result.check.id}`, digest: nativeSettlementDigest(result.check) },
    { kind: 'test', ref: `execution:${contract.id}`, digest: contractDigest },
    { kind: 'test', ref: `receipt:${contract.id}`, digest: nativeSettlementDigest(record.receipt) },
    ...captured.map(item => ({ kind: 'artifact' as const, ref: `artifact:${contract.id}:${item.path}`, digest: item.digest }))];
  const criteriaResults = source.criteria.map((_text, criterionIndex) => ({ criterionIndex,
    status: result.verdicts.get(`native.c${criterionIndex}`) === 'met' ? 'satisfied' as const : result.verdicts.get(`native.c${criterionIndex}`) === 'unmet' ? 'unsatisfied' as const : 'unknown' as const,
    references: references.map(item => item.ref) }));
  const passed = result.check.result === 'pass' && criteriaResults.every(item => item.status === 'satisfied');
  result.recordAction(`native settlement ${admission.contractId}: ${passed ? 'verified' : 'failed'} against ${admission.payloadRevision}`);
  assertCurrent();
  return { attestation: freeze({ outcome: passed ? 'verified' : 'failed', reason: passed ? 'Every original native criterion and quality check passed against host-collected evidence.' : 'Original native criteria or quality did not pass verification.', source: 'host_check', criteriaResults, references }),
    report: (contract.answer?.trim() || 'Native execution finished; see revision-bound verification evidence.').slice(0, 20_000), contractDigest, assertCurrent };
}

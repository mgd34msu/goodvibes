/**
 * memory-record-body.ts, request-body parsers for the daemon-owned memory record
 * routes (add / search / update-review).
 *
 * These build the loose, wire-shaped input objects the route handlers hand to the
 * memory registry. A required field that is missing, a field of the wrong type, and
 * a value outside a closed set (scope, review state) are each a 400 that names the
 * field; nothing is dropped silently. Free-form values (cls, tags, text) are passed
 * through for the store to normalize (the store clamps confidence).
 */

import { jsonErrorResponse } from './error-response.js';
import { isJsonRecord, readOptionalStringField, type JsonRecord } from './route-helpers.js';
import type {
  MemoryBundleInput,
  MemoryLinkInput,
  MemoryProvenanceLinkInput,
  MemoryRecordAddInput,
  MemoryRecordReviewInput,
  MemoryRecordSearchFilterInput,
  MemoryRecordUpdateInput,
} from './integration-route-types.js';

const MEMORY_SCOPES: readonly string[] = ['session', 'project', 'team'];
const MEMORY_REVIEW_STATES: readonly string[] = ['fresh', 'reviewed', 'stale', 'contradicted'];
const MAX_MEMORY_TAGS = 128;

function invalidField(field: string, expected: string): Response {
  return jsonErrorResponse({ error: `${field} must be ${expected}.`, code: 'INVALID_ARGUMENT' }, { status: 400 });
}

/** A field that is absent or JSON null is "not supplied"; anything else must pass its reader. */
function isSupplied(body: JsonRecord, key: string): boolean {
  return body[key] !== undefined && body[key] !== null;
}

type Read<T> = { readonly value: T | undefined } | Response;

function readString(body: JsonRecord, key: string): Read<string> {
  if (!isSupplied(body, key)) return { value: undefined };
  const value = body[key];
  if (typeof value !== 'string') return invalidField(key, 'a string');
  const trimmed = value.trim();
  return { value: trimmed.length > 0 ? trimmed : undefined };
}

function readEnum(body: JsonRecord, key: string, allowed: readonly string[]): Read<string> {
  const read = readString(body, key);
  if (read instanceof Response || read.value === undefined) return read;
  return allowed.includes(read.value) ? read : invalidField(key, `one of ${allowed.join(', ')}`);
}

function readNumber(body: JsonRecord, key: string, check?: (value: number) => boolean, expected = 'a finite number'): Read<number> {
  if (!isSupplied(body, key)) return { value: undefined };
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || (check && !check(value))) return invalidField(key, expected);
  return { value };
}

function readBoolean(body: JsonRecord, key: string): Read<boolean> {
  if (!isSupplied(body, key)) return { value: undefined };
  const value = body[key];
  return typeof value === 'boolean' ? { value } : invalidField(key, 'true or false');
}

/** An array of strings. An empty array is returned as empty so a caller can tell "clear" from "absent". */
function readStrings(body: JsonRecord, key: string, allowed?: readonly string[]): Read<readonly string[]> {
  if (!isSupplied(body, key)) return { value: undefined };
  const value = body[key];
  if (!Array.isArray(value) || value.length > MAX_MEMORY_TAGS || value.some((entry) => typeof entry !== 'string')) {
    return invalidField(key, `an array of at most ${MAX_MEMORY_TAGS} strings`);
  }
  const entries = (value as string[]).map((entry) => entry.trim()).filter(Boolean);
  if (allowed && entries.some((entry) => !allowed.includes(entry))) return invalidField(key, `made of ${allowed.join(', ')}`);
  return { value: entries };
}

/** A string or an array of strings, normalized to an array. */
function readStringOrStrings(body: JsonRecord, key: string, allowed: readonly string[]): Read<readonly string[]> {
  if (typeof body[key] === 'string') return readStrings({ [key]: [body[key]] }, key, allowed);
  return readStrings(body, key, allowed);
}

/**
 * Read a nullable-number field, preserving the three distinct states the store's
 * temporal window needs: a finite number SETS the bound, an explicit `null`
 * CLEARS it, and an absent field leaves it UNCHANGED. Any other value is a 400.
 * Used only where null-to-clear is meaningful (validFrom/validUntil).
 */
function readNullableNumber(body: JsonRecord, key: string): Read<number | null> {
  if (!(key in body) || body[key] === undefined) return { value: undefined };
  const value = body[key];
  if (value === null) return { value: null };
  return typeof value === 'number' && Number.isFinite(value) ? { value } : invalidField(key, 'a finite number or null');
}

/** Parse a provenance link array: each entry needs kind+ref; label is optional. Invalid entries are skipped. */
function readProvenanceField(body: JsonRecord, max = 64): readonly MemoryProvenanceLinkInput[] | undefined {
  const value = body.provenance;
  if (!Array.isArray(value)) return undefined;
  const output: MemoryProvenanceLinkInput[] = [];
  for (let index = 0; index < value.length && index < max; index++) {
    const entry = value[index];
    if (!isJsonRecord(entry)) continue;
    const kind = readOptionalStringField(entry, 'kind');
    const ref = readOptionalStringField(entry, 'ref');
    if (!kind || !ref) continue;
    const label = readOptionalStringField(entry, 'label');
    output.push({ kind, ref, ...(label ? { label } : {}) });
  }
  return output.length > 0 ? output : undefined;
}

/** The review fields shared by an add's `review` object and the review route's body. */
function readReviewFields(source: JsonRecord, prefix: string): MemoryRecordReviewInput | Response {
  const named = (key: string) => (prefix ? `${prefix}.${key}` : key);
  const state = readEnum(source, 'state', MEMORY_REVIEW_STATES);
  if (state instanceof Response) return invalidField(named('state'), `one of ${MEMORY_REVIEW_STATES.join(', ')}`);
  const confidence = readNumber(source, 'confidence');
  if (confidence instanceof Response) return invalidField(named('confidence'), 'a finite number');
  const reviewedBy = readString(source, 'reviewedBy');
  if (reviewedBy instanceof Response) return invalidField(named('reviewedBy'), 'a string');
  const staleReason = readString(source, 'staleReason');
  if (staleReason instanceof Response) return invalidField(named('staleReason'), 'a string');
  return {
    ...(state.value ? { state: state.value } : {}),
    ...(confidence.value !== undefined ? { confidence: confidence.value } : {}),
    ...(reviewedBy.value ? { reviewedBy: reviewedBy.value } : {}),
    ...(staleReason.value ? { staleReason: staleReason.value } : {}),
  };
}

function readReviewField(body: JsonRecord): MemoryRecordAddInput['review'] | undefined | Response {
  const value = body.review;
  if (value === undefined || value === null) return undefined;
  if (!isJsonRecord(value)) return invalidField('review', 'an object');
  const fields = readReviewFields(value, 'review');
  if (fields instanceof Response) return fields;
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * Parse POST /api/memory/records, cls and summary are required. `scope` and
 * `review.state` are closed sets: the store writes them as given but reads them
 * back strictly, so one record with another value would make every later read fail.
 */
export function parseMemoryRecordAddBody(body: JsonRecord): MemoryRecordAddInput | Response {
  const cls = readString(body, 'cls');
  if (cls instanceof Response) return cls;
  const summary = readString(body, 'summary');
  if (summary instanceof Response) return summary;
  if (!cls.value) return jsonErrorResponse({ error: 'Missing cls', code: 'INVALID_ARGUMENT' }, { status: 400 });
  if (!summary.value) return jsonErrorResponse({ error: 'Missing summary', code: 'INVALID_ARGUMENT' }, { status: 400 });
  const scope = readEnum(body, 'scope', MEMORY_SCOPES);
  if (scope instanceof Response) return scope;
  const detail = readString(body, 'detail');
  if (detail instanceof Response) return detail;
  const tags = readStrings(body, 'tags');
  if (tags instanceof Response) return tags;
  const review = readReviewField(body);
  if (review instanceof Response) return review;
  const provenance = readProvenanceField(body);
  const id = readString(body, 'id');
  if (id instanceof Response) return id;
  const project = readString(body, 'project');
  if (project instanceof Response) return project;
  return {
    ...(id.value ? { id: id.value } : {}),
    cls: cls.value,
    summary: summary.value,
    ...(scope.value ? { scope: scope.value } : {}),
    // Only a "this project" record is for a project.
    ...(project.value && (scope.value ?? 'project') === 'project' ? { project: project.value } : {}),
    ...(detail.value ? { detail: detail.value } : {}),
    ...(tags.value && tags.value.length > 0 ? { tags: tags.value } : {}),
    ...(provenance ? { provenance } : {}),
    ...(review ? { review } : {}),
  };
}

/**
 * Parse a memory search filter, every field optional but each one checked. Shared by
 * search/list/searchSemantic/export. A field of the wrong type is a 400, not a wider
 * result: an export asked for `stale` records must never return every record.
 */
export function parseMemoryRecordFilterBody(body: JsonRecord): MemoryRecordSearchFilterInput | Response {
  const scope = readEnum(body, 'scope', MEMORY_SCOPES);
  if (scope instanceof Response) return scope;
  const cls = readString(body, 'cls');
  if (cls instanceof Response) return cls;
  const tags = readStrings(body, 'tags');
  if (tags instanceof Response) return tags;
  const query = readString(body, 'query');
  if (query instanceof Response) return query;
  const semantic = readBoolean(body, 'semantic');
  if (semantic instanceof Response) return semantic;
  const since = readNumber(body, 'since');
  if (since instanceof Response) return since;
  const reviewState = readStringOrStrings(body, 'reviewState', MEMORY_REVIEW_STATES);
  if (reviewState instanceof Response) return reviewState;
  const minConfidence = readNumber(body, 'minConfidence');
  if (minConfidence instanceof Response) return minConfidence;
  const provenanceKinds = readStrings(body, 'provenanceKinds');
  if (provenanceKinds instanceof Response) return provenanceKinds;
  const staleOnly = readBoolean(body, 'staleOnly');
  if (staleOnly instanceof Response) return staleOnly;
  // A negative limit would reach Array.prototype.slice(0, -n), which keeps all but the last n.
  const limit = readNumber(body, 'limit', (value) => Number.isInteger(value) && value >= 0, 'a whole number of at least 0');
  if (limit instanceof Response) return limit;
  const project = readString(body, 'project');
  if (project instanceof Response) return project;
  return {
    ...(scope.value ? { scope: scope.value } : {}),
    ...(project.value ? { project: project.value } : {}),
    ...(cls.value ? { cls: cls.value } : {}),
    ...(tags.value && tags.value.length > 0 ? { tags: tags.value } : {}),
    ...(query.value ? { query: query.value } : {}),
    ...(semantic.value !== undefined ? { semantic: semantic.value } : {}),
    ...(since.value !== undefined ? { since: since.value } : {}),
    ...(reviewState.value && reviewState.value.length > 0 ? { reviewState: reviewState.value } : {}),
    ...(minConfidence.value !== undefined ? { minConfidence: minConfidence.value } : {}),
    ...(provenanceKinds.value && provenanceKinds.value.length > 0 ? { provenanceKinds: provenanceKinds.value } : {}),
    ...(staleOnly.value !== undefined ? { staleOnly: staleOnly.value } : {}),
    ...(limit.value !== undefined ? { limit: limit.value } : {}),
  };
}

/** Parse POST /api/memory/records/search, every field optional. */
export function parseMemoryRecordSearchBody(
  body: JsonRecord,
): { readonly filter: MemoryRecordSearchFilterInput; readonly recall: boolean } | Response {
  const filter = parseMemoryRecordFilterBody(body);
  if (filter instanceof Response) return filter;
  const recall = readBoolean(body, 'recall');
  if (recall instanceof Response) return recall;
  return { filter, recall: recall.value === true };
}

/**
 * Parse POST /api/memory/records/:id/update, editable fields
 * (cls/scope/summary/detail/tags + the temporal validity window). All optional; the
 * store leaves unset fields unchanged. NOT a review update (that is the /review
 * route), this edits content/scope, e.g. promoting a record project→team.
 *
 * validFrom/validUntil carry the store's three-state window semantics: a number
 * sets the bound, an explicit `null` clears it, and an absent field leaves it
 * unchanged, so a proposal that changes only the window round-trips. `tags: []`
 * clears the tags; an absent `tags` leaves them unchanged.
 */
export function parseMemoryRecordUpdateBody(body: JsonRecord): MemoryRecordUpdateInput | Response {
  const cls = readString(body, 'cls');
  if (cls instanceof Response) return cls;
  const scope = readEnum(body, 'scope', MEMORY_SCOPES);
  if (scope instanceof Response) return scope;
  const summary = readString(body, 'summary');
  if (summary instanceof Response) return summary;
  let detail: string | undefined;
  if (body.detail === null) detail = '';
  else {
    const read = readString(body, 'detail');
    if (read instanceof Response) return read;
    detail = read.value;
  }
  const tags = readStrings(body, 'tags');
  if (tags instanceof Response) return tags;
  const validFrom = readNullableNumber(body, 'validFrom');
  if (validFrom instanceof Response) return validFrom;
  const validUntil = readNullableNumber(body, 'validUntil');
  if (validUntil instanceof Response) return validUntil;
  const project = readString(body, 'project');
  if (project instanceof Response) return project;
  return {
    ...(cls.value ? { cls: cls.value } : {}),
    ...(scope.value ? { scope: scope.value } : {}),
    ...(project.value ? { project: project.value } : {}),
    ...(summary.value ? { summary: summary.value } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(tags.value ? { tags: tags.value } : {}),
    ...(validFrom.value !== undefined ? { validFrom: validFrom.value } : {}),
    ...(validUntil.value !== undefined ? { validUntil: validUntil.value } : {}),
  };
}

/** Parse POST /api/memory/records/:id/links, toId and relation are required (fromId is the path id). */
export function parseMemoryLinkBody(body: JsonRecord): MemoryLinkInput | Response {
  const toId = readOptionalStringField(body, 'toId');
  const relation = readOptionalStringField(body, 'relation');
  if (!toId) return jsonErrorResponse({ error: 'Missing toId', code: 'INVALID_ARGUMENT' }, { status: 400 });
  if (!relation) return jsonErrorResponse({ error: 'Missing relation', code: 'INVALID_ARGUMENT' }, { status: 400 });
  return { toId, relation };
}

/**
 * Parse POST /api/memory/records/import, a { bundle } envelope holding a MemoryBundle.
 * Records/links are passed through loosely; the store re-normalizes scope/reviewState/
 * confidence per record and skips ids it already holds (no-loss id-keyed union).
 */
export function parseMemoryBundleImportBody(body: JsonRecord): MemoryBundleInput | Response {
  const bundle = body.bundle;
  if (!isJsonRecord(bundle)) {
    return jsonErrorResponse({ error: 'Missing bundle', code: 'INVALID_ARGUMENT' }, { status: 400 });
  }
  if (!Array.isArray(bundle.records)) {
    return jsonErrorResponse({ error: 'bundle.records must be an array', code: 'INVALID_ARGUMENT' }, { status: 400 });
  }
  if (bundle.links !== undefined && !Array.isArray(bundle.links)) {
    return jsonErrorResponse({ error: 'bundle.links must be an array', code: 'INVALID_ARGUMENT' }, { status: 400 });
  }
  return { bundle: bundle as unknown as MemoryBundleInput['bundle'] };
}

/** Parse POST /api/memory/records/:id/review, all review fields optional; id comes from the path. */
export function parseMemoryRecordReviewBody(body: JsonRecord): MemoryRecordReviewInput | Response {
  return readReviewFields(body, '');
}

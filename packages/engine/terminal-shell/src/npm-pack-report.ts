/** Parse npm pack reports once across package-verification surfaces. */
export interface NpmPackDryRunResult {
  readonly files: readonly string[];
  readonly entryCount: number;
  readonly unpackedSize: number;
}
interface NpmPackJsonEntry {
  readonly files?:
    | ReadonlyArray<{
        readonly path?: string | undefined;
      } | null>
    | undefined;
  readonly entryCount?: number | undefined;
  readonly unpackedSize?: number | undefined;
}
function describeNpmPackOutput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'no output at all';
  const preview = trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
  return `${trimmed.length} characters of output beginning: ${preview}`;
}
// npm wrappers (version-manager shims, "npm notice" lines) sometimes print plain text
// on stdout alongside the JSON document, and that text can itself contain brackets
// ("[notice] ...", "[1/3] ..."). Yield each balanced bracketed span in order so the
// caller can keep the first one that is the report, tracking string literals so braces
// inside paths do not confuse the depth count.
function* jsonCandidates(raw: string): Generator<string> {
  let from = 0;
  for (;;) {
    const start = raw.slice(from).search(/[[{]/);
    if (start < 0) return;
    const first = from + start;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = first; index < raw.length && end < 0; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '[' || char === '{') depth += 1;
      else if (char === ']' || char === '}') {
        depth -= 1;
        if (depth === 0) end = index;
      }
    }
    if (end < 0) {
      from = first + 1;
      continue;
    }
    yield raw.slice(first, end + 1);
    from = end + 1;
  }
}
function looksLikePackEntry(value: unknown): value is NpmPackJsonEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.files) || typeof candidate.entryCount === 'number' || typeof candidate.unpackedSize === 'number';
}
function selectPackEntry(parsed: unknown): NpmPackJsonEntry | undefined {
  // npm 10/11 emit `[{ files, entryCount, unpackedSize }]`.
  if (Array.isArray(parsed)) return parsed.find(looksLikePackEntry);
  // npm 12 emits `{ "<package-name>": { files, entryCount, unpackedSize } }`.
  if (looksLikePackEntry(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return Object.values(parsed as Record<string, unknown>).find(looksLikePackEntry);
  return undefined;
}
export function parseNpmPackJson(raw: string): NpmPackDryRunResult {
  let sawCandidate = false;
  let firstParseError: string | undefined;
  let entry: NpmPackJsonEntry | undefined;
  for (const candidate of jsonCandidates(raw)) {
    sawCandidate = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      firstParseError ??= error instanceof Error ? error.message : String(error);
      continue;
    }
    entry = selectPackEntry(parsed);
    if (entry) break;
  }
  if (!sawCandidate) {
    throw new Error(`npm pack --json --dry-run printed no JSON document; npm emitted ${describeNpmPackOutput(raw)}`);
  }
  if (!entry) {
    if (firstParseError !== undefined) {
      throw new Error(
        `npm pack --json --dry-run printed JSON that could not be parsed (${firstParseError}); npm emitted ${describeNpmPackOutput(raw)}`,
      );
    }
    throw new Error(
      `npm pack --json --dry-run returned an unrecognized JSON shape; expected an array of pack results or an object keyed by package name, but npm emitted ${describeNpmPackOutput(raw)}`,
    );
  }
  return {
    files: Array.isArray(entry.files) ? entry.files.map((file) => String(file?.path ?? '')) : [],
    entryCount: Number(entry.entryCount ?? 0),
    unpackedSize: Number(entry.unpackedSize ?? 0),
  };
}

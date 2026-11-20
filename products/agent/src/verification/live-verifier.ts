import { createVerificationCompactor } from '@goodvibes-jev/engine/terminal-shell/verification-primitives';
import { resolveVerificationHostUrl, verificationHostTarget } from '@goodvibes-jev/engine/terminal-shell/verification-primitives';
import { bearerFor, type DaemonTarget } from '@goodvibes-jev/engine/platform/platform/runtime/client/daemon-target';
import { writeVerificationReportFiles } from '@goodvibes-jev/engine/terminal-shell/verification-primitives';
import {
  createVerificationPrimitives,
  renderVerificationTables,
  validateDaemonHealth,
  type LiveVerificationStatus,
  type LiveVerificationCheck,
} from '@goodvibes-jev/engine/terminal-shell/verification-primitives';
export type { LiveVerificationStatus, LiveVerificationCheck } from '@goodvibes-jev/engine/terminal-shell/verification-primitives';

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const AGENT_KNOWLEDGE_ROUTE = '/api/goodvibes-agent/knowledge';
const DEFAULT_KNOWLEDGE_ROUTE = '/api/knowledge';
/** Ingest runs extraction on the host, so it gets longer than a plain read. */
const KNOWLEDGE_PROBE_TIMEOUT_MS = 30_000;

// The scenario ids are stable report keys; the titles say what each check
// actually observes. Isolation itself is proven only by the seeded probe in
// `agent-knowledge-search-isolated`.
const AGENT_KNOWLEDGE_READ_ROUTE_CHECKS = [
  {
    id: 'agent-knowledge-sources-isolated',
    title: 'Agent Knowledge sources route',
    route: `${AGENT_KNOWLEDGE_ROUTE}/sources`,
  },
  {
    id: 'agent-knowledge-nodes-isolated',
    title: 'Agent Knowledge nodes route',
    route: `${AGENT_KNOWLEDGE_ROUTE}/nodes`,
  },
  {
    id: 'agent-knowledge-issues-isolated',
    title: 'Agent Knowledge issues route',
    route: `${AGENT_KNOWLEDGE_ROUTE}/issues`,
  },
  {
    id: 'agent-knowledge-map-isolated',
    title: 'Agent Knowledge map route',
    route: `${AGENT_KNOWLEDGE_ROUTE}/map`,
  },
  {
    id: 'agent-knowledge-connectors-isolated',
    title: 'Agent Knowledge connectors route',
    route: `${AGENT_KNOWLEDGE_ROUTE}/connectors`,
  },
] as const;
/**
 * Canonical set of live-verification scenario ids this verifier emits. Kept
 * next to the checks that produce them so a capability declared `certified` in
 * the capability registry can be pinned against a real scenario id. The
 * Agent-Knowledge read-route ids are derived from their check specs so the two
 * cannot drift apart.
 */
export const LIVE_VERIFICATION_SCENARIO_IDS: readonly string[] = [
  'compiled-cli-present',
  'cli-version',
  'cli-status-json',
  'cli-compat-json',
  'cli-agent-knowledge-status',
  'cli-providers',
  'cli-doctor',
  'connected-host-status',
  'connected-host-health',
  'openai-compatible-models',
  'agent-knowledge-status',
  'agent-knowledge-ask-isolated',
  'agent-knowledge-search-isolated',
  ...AGENT_KNOWLEDGE_READ_ROUTE_CHECKS.map((check) => check.id),
];

const STATUS_RELEASE_DETAIL = 'Status JSON command completed; provider/model identifiers omitted from release artifact.';
const PROVIDERS_RELEASE_DETAIL =
  'Provider inventory command completed; provider names and credential posture omitted from release artifact.';
const DOCTOR_RELEASE_DETAIL =
  'Doctor command completed without findings; provider/model identifiers and credential posture omitted from release artifact.';
const KNOWLEDGE_RELEASE_DETAIL = 'Response body omitted from release artifact; it can hold the operator\'s knowledge text.';

function doctorAdvisoryDetail(count: number): string {
  return `Doctor command completed with ${count} operator-configuration risk advisory(ies) and no errors; provider/model identifiers and credential posture omitted from release artifact.`;
}

/**
 * The doctor exits non-zero for ANY finding, including `[risk:*]` advisories
 * that describe the operator's own intentional configuration (e.g.
 * behavior.autoApprove on a trusted machine). Those advisories are honest and
 * must keep printing, but they are not release defects, so a doctor run
 * whose ONLY findings are risk advisories (no Errors section) must not turn a
 * strict live verification red. Returns the advisory count when the non-zero
 * exit is advisory-only, or null when the exit signals a real problem
 * (errors present, no parseable findings, crash).
 */
export function doctorRiskAdvisoryOnlyCount(result: { exitCode: number | null; stdout: string }): number | null {
  if (result.exitCode === 0) return 0;
  if (result.exitCode !== 1) return null;
  if (/^Errors\b/m.test(result.stdout)) return null;
  const findings = [...result.stdout.matchAll(/^\s*- \[([a-z]+):/gm)].map((m) => m[1]);
  if (findings.length === 0) return null;
  return findings.every((kind) => kind === 'risk') ? findings.length : null;
}

export interface LiveVerificationOptions {
  homeDir: string;
  binaryPath: string;
  projectRoot: string;
  connectedHostBaseUrl?: string;
  token?: string;
  strict?: boolean;
}

export interface LiveVerificationReport {
  generatedAt: string;
  homeDir: string;
  binaryPath: string;
  connectedHostBaseUrl: string;
  strict: boolean;
  checks: LiveVerificationCheck[];
  counts: Record<LiveVerificationStatus, number>;
  ok: boolean;
}

export interface LiveVerificationRedactionContext {
  homeDir: string;
  userHomeDir: string;
  /** The account's real home directory, masked as well when it differs from `userHomeDir`. */
  realHomeDir?: string;
  projectRoot: string;
  binaryPath: string;
  /** Operator/daemon tokens that must never appear verbatim in release artifacts. */
  tokens?: readonly string[];
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
    .replace(/Authorization:\s*[A-Za-z]+\s+[A-Za-z0-9._~+/=-]+/gi, 'Authorization: [redacted]')
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token":"[redacted]"')
    .replace(/(?<![A-Za-z])(?:access_token|api[_-]?key|token)\s*=\s*[^\s&"'`]+/gi, (m) => m.replace(/=.*/, '=[redacted]'));
}

function replaceLiteral(text: string, search: string, replacement: string): string {
  return search.length > 1 ? text.split(search).join(replacement) : text;
}

function redactLocalPaths(text: string, context: LiveVerificationRedactionContext): string {
  const replacements = [
    [context.binaryPath, '[agent-binary]'],
    [context.projectRoot, '[project-root]'],
    [context.homeDir, '[goodvibes-home]'],
    [context.userHomeDir, '[home]'],
    [context.realHomeDir ?? '', '[home]'],
  ] as const;
  return replacements
    .filter(([value]) => value.length > 1)
    .sort(([left], [right]) => right.length - left.length)
    .reduce((output, [value, replacement]) => replaceLiteral(output, value, replacement), text)
    .replace(/\[home\]\/[^"'\s`]+\/home\//g, '[home]/');
}

function redactPrivateNetworkAddresses(text: string): string {
  return text.replace(/\b(?:10(?:\.[0-9]{1,3}){3}|(?:192\.168|172\.(?:1[6-9]|2[0-9]|3[0-1]))(?:\.[0-9]{1,3}){2})\b/g, '[private-ip]');
}

function redactForReleaseArtifact(text: string, context: LiveVerificationRedactionContext): string {
  let result = redactPrivateNetworkAddresses(redactLocalPaths(redact(text), context));
  if (context.tokens) {
    for (const token of context.tokens) {
      if (token.length >= 8) {
        result = result.split(token).join('[redacted]');
      }
    }
  }
  return result;
}

const compact = createVerificationCompactor(redact);
const { runCommand, commandCheck, fetchCheck, countStatuses } = createVerificationPrimitives({
  compact,
  error: (error) => (error instanceof Error ? error.message : String(error)),
  missingBearer: 'No connected-host bearer token was available.',
  validateJsonOnNonZero: true,
});

/**
 * The token for the host being checked, released only for its origin: a
 * passed token or GOODVIBES_CONNECTED_HOST_TOKEN goes to that host; this
 * machine's daemon token (GOODVIBES_DAEMON_TOKEN or its operator token file)
 * only when the host is this machine's daemon. Every request of the run goes
 * to `connectedHostBaseUrl`, so the one origin check covers them all.
 */
function connectedHostTarget(homeDir: string, connectedHostBaseUrl: string, explicitToken: string | undefined): DaemonTarget {
  return verificationHostTarget({
    homeDir, url: connectedHostBaseUrl, explicitToken,
    hostEnvKeys: ['GOODVIBES_CONNECTED_HOST_TOKEN'], localEnvKeys: ['GOODVIBES_DAEMON_TOKEN'],
    readJson: readJsonFile, settingsPath: join(homeDir, 'agent', 'settings.json'),
  });
}

function resolveConnectedHostBaseUrl(homeDir: string, explicit?: string): string {
  return resolveVerificationHostUrl(
    homeDir,
    explicit,
    ['GOODVIBES_CONNECTED_HOST_URL', 'GOODVIBES_AGENT_RUNTIME_URL', 'GOODVIBES_DAEMON_URL'],
    readJsonFile,
    join(homeDir, 'agent', 'settings.json'),
  );
}

function commandHomeDirectory(homeDir: string): string {
  const resolved = resolve(homeDir);
  return resolved.split(/[\\/]/).pop() === '.goodvibes' ? dirname(resolved) : resolved;
}

function buildCommandEnv(homeDir: string, connectedHostBaseUrl: string, token: string | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: '1',
    GOODVIBES_AGENT_HOME: commandHomeDirectory(homeDir),
    GOODVIBES_AGENT_RUNTIME_URL: connectedHostBaseUrl,
    GOODVIBES_CONNECTED_HOST_URL: connectedHostBaseUrl,
    ...(token ? { GOODVIBES_CONNECTED_HOST_TOKEN: token } : {}),
  };
}

async function fetchJsonCheck(
  id: string,
  title: string,
  url: string,
  token: string | undefined,
  options: {
    readonly method?: 'GET' | 'POST';
    readonly body?: unknown;
    readonly validate: (status: number, body: string) => { status: LiveVerificationStatus; summary: string; detail?: string };
  },
): Promise<LiveVerificationCheck> {
  if (!token) {
    return {
      id,
      title,
      status: 'skip',
      summary: 'No connected-host bearer token was available.',
    };
  }
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.text();
    const validated = options.validate(response.status, body);
    return {
      id,
      title,
      ...validated,
      detail: validated.detail ?? compact(body),
    };
  } catch (error) {
    return {
      id,
      title,
      status: 'fail',
      summary: 'Request failed.',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function validateAgentKnowledgeJsonBody(
  label: string,
  body: string,
  passSummary: string,
): { status: LiveVerificationStatus; summary: string; detail?: string } {
  try {
    JSON.parse(body);
  } catch {
    return { status: 'fail', summary: `${label} was not parseable JSON.` };
  }
  return { status: 'pass', summary: passSummary, detail: KNOWLEDGE_RELEASE_DETAIL };
}

function validateAgentKnowledgeJsonRoute(
  route: string,
  label: string,
): (status: number, body: string) => { status: LiveVerificationStatus; summary: string; detail?: string } {
  return (status, body) => {
    if (status !== 200) return { status: 'fail', summary: `${route} returned ${status}.` };
    return validateAgentKnowledgeJsonBody(label, body, `${label} returned 200 with parseable JSON.`);
  };
}

interface KnowledgeProbe {
  readonly marker: string;
  readonly title: string;
}

/**
 * The one probe each space keeps. One unbroken token per space, so neither
 * probe's words occur in the other or anywhere else in the operator's
 * knowledge; fixed, so every run reuses the source an earlier run seeded
 * instead of adding another.
 */
function knowledgeProbe(space: 'agent' | 'default'): KnowledgeProbe {
  const marker = `gvprobe${space}livecheck4f9c2e7a1b6d`;
  return { marker, title: `Live verification probe ${marker}` };
}

type ProbeStep<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly summary: string; readonly detail?: string };

async function probeRequest(
  url: string,
  token: string,
  init: { readonly body: FormData | string; readonly json: boolean },
): Promise<ProbeStep<{ status: number; body: string }>> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        // FormData sets its own multipart boundary header.
        ...(init.json ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body,
      signal: AbortSignal.timeout(KNOWLEDGE_PROBE_TIMEOUT_MS),
    });
    return { ok: true, value: { status: response.status, body: await response.text() } };
  } catch (error) {
    return { ok: false, summary: `Request to ${new URL(url).pathname} failed.`, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Seeds one probe source through a knowledge ingest route and returns its source id. */
async function seedKnowledgeProbe(baseUrl: string, routePrefix: string, token: string, probe: KnowledgeProbe): Promise<ProbeStep<string>> {
  const route = `${routePrefix}/ingest/artifact`;
  const form = new FormData();
  form.append('file', new Blob([`${probe.title}\n\nThis source was written by the GoodVibes Agent live verification to check knowledge isolation.\n`], { type: 'text/plain' }), `${probe.marker}.txt`);
  form.append('title', probe.title);
  form.append('tags', 'live-verification');
  form.append('metadata', JSON.stringify({ originSurface: 'goodvibes-agent-live-verification' }));
  const sent = await probeRequest(`${baseUrl}${route}`, token, { body: form, json: false });
  if (!sent.ok) return sent;
  const { status, body } = sent.value;
  if (status !== 200 && status !== 201) {
    return {
      ok: false,
      summary: `Seeding a probe source through ${route} returned ${status}; isolation was not checked. Use an operator token that may write knowledge.`,
      detail: compact(body),
    };
  }
  try {
    const id = (JSON.parse(body) as { source?: { id?: unknown } }).source?.id;
    if (typeof id === 'string' && id.length > 0) return { ok: true, value: id };
  } catch {
    // Reported below.
  }
  return { ok: false, summary: `${route} accepted the probe but returned no source id; isolation was not checked.`, detail: compact(body) };
}

/** The search result on `routePrefix` that is the probe (by its source id or its unique marker), or null when none is. */
async function searchKnowledgeProbe(baseUrl: string, routePrefix: string, token: string, probe: KnowledgeProbe, sourceId?: string): Promise<ProbeStep<{ readonly sourceId: string } | null>> {
  const route = `${routePrefix}/search`;
  const sent = await probeRequest(`${baseUrl}${route}`, token, { body: JSON.stringify({ query: probe.title, limit: 10 }), json: true });
  if (!sent.ok) return sent;
  const { status, body } = sent.value;
  if (status !== 200) return { ok: false, summary: `${route} returned ${status}.`, detail: compact(body) };
  let results: unknown;
  try {
    results = (JSON.parse(body) as { results?: unknown }).results;
  } catch {
    return { ok: false, summary: `${route} did not return parseable JSON.` };
  }
  if (!Array.isArray(results)) return { ok: false, summary: `${route} returned no results array.` };
  for (const entry of results as unknown[]) {
    const record = entry as { id?: unknown; source?: { id?: unknown } } | null;
    const matched = (sourceId !== undefined && (record?.id === sourceId || record?.source?.id === sourceId)) || JSON.stringify(entry).includes(probe.marker);
    if (!matched) continue;
    const found = typeof record?.source?.id === 'string' ? record.source.id : typeof record?.id === 'string' ? record.id : sourceId ?? probe.marker;
    return { ok: true, value: { sourceId: found } };
  }
  return { ok: true, value: null };
}

/** Whether the Agent search route returned the probe. */
async function agentSearchReturns(baseUrl: string, token: string, probe: KnowledgeProbe, sourceId: string): Promise<ProbeStep<boolean>> {
  return await searchReturns(baseUrl, AGENT_KNOWLEDGE_ROUTE, token, probe, sourceId);
}

/** Whether a space's search route returned the probe. */
async function searchReturns(baseUrl: string, routePrefix: string, token: string, probe: KnowledgeProbe, sourceId: string): Promise<ProbeStep<boolean>> {
  const found = await searchKnowledgeProbe(baseUrl, routePrefix, token, probe, sourceId);
  return found.ok ? { ok: true, value: found.value !== null } : found;
}

/**
 * The space's probe source: the one an earlier run seeded when that space's
 * own search returns it, else seeded now. Repeated runs add nothing to the
 * host's knowledge.
 */
async function ensureKnowledgeProbe(baseUrl: string, routePrefix: string, token: string, probe: KnowledgeProbe): Promise<ProbeStep<string>> {
  const existing = await searchKnowledgeProbe(baseUrl, routePrefix, token, probe);
  if (!existing.ok) return { ...existing, summary: `Looking for the kept probe source: ${existing.summary} Isolation was not checked.` };
  if (existing.value) return { ok: true, value: existing.value.sourceId };
  return seedKnowledgeProbe(baseUrl, routePrefix, token, probe);
}

/**
 * Keeps one probe in the Agent space and one in the default space (seeded
 * through each ingest route the first time, reused after), then searches for
 * each on both routes: each space's search returns its own probe and not the
 * other space's. This is the observation that tells a working split from
 * crossed spaces in either direction; an empty store cannot pass it.
 */
async function checkAgentKnowledgeIsolation(baseUrl: string, token: string | undefined): Promise<LiveVerificationCheck> {
  const id = 'agent-knowledge-search-isolated';
  const title = 'Agent Knowledge isolation (seeded probes)';
  if (!token) return { id, title, status: 'skip', summary: 'No connected-host bearer token was available.' };
  const fail = (step: { summary: string; detail?: string }): LiveVerificationCheck => ({
    id, title, status: 'fail', summary: step.summary, ...(step.detail ? { detail: step.detail } : {}),
  });
  const agentProbe = knowledgeProbe('agent');
  const defaultProbe = knowledgeProbe('default');
  const agentSource = await ensureKnowledgeProbe(baseUrl, AGENT_KNOWLEDGE_ROUTE, token, agentProbe);
  if (!agentSource.ok) return fail(agentSource);
  const defaultSource = await ensureKnowledgeProbe(baseUrl, DEFAULT_KNOWLEDGE_ROUTE, token, defaultProbe);
  if (!defaultSource.ok) return fail(defaultSource);
  const agentFound = await agentSearchReturns(baseUrl, token, agentProbe, agentSource.value);
  if (!agentFound.ok) return fail(agentFound);
  if (!agentFound.value) {
    return fail({
      summary: 'The Agent search route did not return the source just seeded through the Agent ingest route; isolation could not be observed.',
      detail: `Agent probe source ${agentSource.value} was not in the results.`,
    });
  }
  const defaultFound = await agentSearchReturns(baseUrl, token, defaultProbe, defaultSource.value);
  if (!defaultFound.ok) return fail(defaultFound);
  if (defaultFound.value) {
    return fail({
      summary: 'The Agent search route returned a source seeded through the default knowledge route: the knowledge spaces are crossed.',
      detail: `Default probe source ${defaultSource.value} appeared in Agent search results.`,
    });
  }
  // The other direction: default search returns its own probe and not the Agent's.
  const defaultOwn = await searchReturns(baseUrl, DEFAULT_KNOWLEDGE_ROUTE, token, defaultProbe, defaultSource.value);
  if (!defaultOwn.ok) return fail(defaultOwn);
  if (!defaultOwn.value) {
    return fail({
      summary: 'The default search route did not return the source seeded through the default ingest route; isolation could not be observed in that direction.',
      detail: `Default probe source ${defaultSource.value} was not in the default search results.`,
    });
  }
  const agentInDefault = await searchReturns(baseUrl, DEFAULT_KNOWLEDGE_ROUTE, token, agentProbe, agentSource.value);
  if (!agentInDefault.ok) return fail(agentInDefault);
  if (agentInDefault.value) {
    return fail({
      summary: 'The default search route returned a source seeded through the Agent ingest route: the knowledge spaces are crossed.',
      detail: `Agent probe source ${agentSource.value} appeared in default search results.`,
    });
  }
  return {
    id,
    title,
    status: 'pass',
    summary: 'Each search route returned its own probe and not the other space\'s.',
    detail: `Agent search: Agent probe ${agentSource.value} found, default probe ${defaultSource.value} absent. Default search: default probe found, Agent probe absent. Each space keeps one probe source, tagged live-verification, which later runs reuse instead of adding another.`,
  };
}

export async function buildLiveVerificationReport(options: LiveVerificationOptions): Promise<LiveVerificationReport> {
  const homeDir = resolve(options.homeDir);
  const projectRoot = resolve(options.projectRoot);
  const binaryPath = resolve(options.binaryPath);
  const connectedHostBaseUrl = resolveConnectedHostBaseUrl(homeDir, options.connectedHostBaseUrl);
  const target = connectedHostTarget(homeDir, connectedHostBaseUrl, options.token);
  // The bearer itself, for the commands this run starts and for redacting their output.
  const token = target.credential ? bearerFor(target.credential, connectedHostBaseUrl) : undefined;
  const commandEnv = buildCommandEnv(homeDir, connectedHostBaseUrl, token);
  const checks: LiveVerificationCheck[] = [];

  checks.push({
    id: 'compiled-cli-present',
    title: 'Compiled GoodVibes Agent CLI binary',
    status: existsSync(binaryPath) ? 'pass' : 'fail',
    summary: existsSync(binaryPath) ? `Found ${binaryPath}.` : `Missing ${binaryPath}.`,
  });

  if (existsSync(binaryPath)) {
    checks.push(
      commandCheck(
        'cli-version',
        'Agent CLI version command',
        await runCommand(binaryPath, ['--version'], projectRoot),
        'Agent CLI version returned successfully.',
      ),
    );
    checks.push(
      commandCheck(
        'cli-status-json',
        'Agent CLI status JSON command',
        await runCommand(binaryPath, ['--runtime-url', connectedHostBaseUrl, 'status', '--json'], projectRoot, { env: commandEnv }),
        'Agent CLI status returned parseable JSON.',
        { parseJson: true, passDetail: STATUS_RELEASE_DETAIL },
      ),
    );
    checks.push(
      commandCheck(
        'cli-compat-json',
        'Agent CLI compatibility JSON command',
        await runCommand(binaryPath, ['--runtime-url', connectedHostBaseUrl, 'compat', '--json'], projectRoot, { env: commandEnv }),
        'Agent CLI compatibility returned parseable JSON.',
        { parseJson: true, warnOnNonZero: true },
      ),
    );
    checks.push(
      commandCheck(
        'cli-agent-knowledge-status',
        'Agent Knowledge CLI status command',
        await runCommand(binaryPath, ['--runtime-url', connectedHostBaseUrl, 'knowledge', 'status', '--json'], projectRoot, {
          env: commandEnv,
        }),
        'Agent Knowledge status returned parseable JSON.',
        { parseJson: true, warnOnNonZero: true },
      ),
    );
    checks.push(
      commandCheck(
        'cli-providers',
        'Agent CLI providers command',
        await runCommand(binaryPath, ['providers'], projectRoot),
        'Provider inventory rendered successfully.',
        { passDetail: PROVIDERS_RELEASE_DETAIL },
      ),
    );
    const doctorResult = await runCommand(binaryPath, ['--runtime-url', connectedHostBaseUrl, 'doctor', '--output', 'text'], projectRoot, {
      env: commandEnv,
    });
    const doctorAdvisories = doctorRiskAdvisoryOnlyCount(doctorResult);
    checks.push(
      commandCheck(
        'cli-doctor',
        'CLI doctor command',
        doctorAdvisories !== null ? { ...doctorResult, exitCode: 0 } : doctorResult,
        doctorAdvisories !== null && doctorAdvisories > 0
          ? `Doctor completed; ${doctorAdvisories} operator-configuration risk advisory(ies) noted (intentional trust posture, not a release defect).`
          : 'Doctor completed without findings.',
        { warnOnNonZero: true, passDetail: doctorAdvisories !== null && doctorAdvisories > 0 ? doctorAdvisoryDetail(doctorAdvisories) : DOCTOR_RELEASE_DETAIL },
      ),
    );
  }

  checks.push(
    await fetchCheck(
      'connected-host-status',
      'Authenticated connected-host /status',
      `${connectedHostBaseUrl}/status`,
      target,
      (status, body) => {
        if (status !== 200) return { status: 'fail', summary: `/status returned ${status}.` };
        try {
          JSON.parse(body) as unknown;
          return { status: 'pass', summary: '/status returned 200 with parseable JSON.' };
        } catch {
          return { status: 'warn', summary: '/status returned 200 but was not parseable JSON.' };
        }
      },
    ),
  );

  checks.push(
    await fetchCheck(
      'connected-host-health',
      'Authenticated connected-host /api/health',
      `${connectedHostBaseUrl}/api/health`,
      target,
      validateDaemonHealth,
    ),
  );

  checks.push(
    await fetchCheck(
      'openai-compatible-models',
      'OpenAI-compatible /v1/models route',
      `${connectedHostBaseUrl}/v1/models`,
      target,
      (status, body) => {
        if (status !== 200) return { status: 'fail', summary: `/v1/models returned ${status}.` };
        try {
          const parsed = JSON.parse(body) as { data?: unknown };
          const models = Array.isArray(parsed.data) ? parsed.data.length : 0;
          return {
            status: models > 0 ? 'pass' : 'warn',
            summary: `/v1/models returned ${models} model(s).`,
            detail: `/v1/models returned ${models} model(s); model identifiers omitted from release artifact.`,
          };
        } catch {
          return { status: 'warn', summary: '/v1/models returned 200 but was not parseable JSON.' };
        }
      },
    ),
  );

  checks.push(
    await fetchJsonCheck(
      'agent-knowledge-status',
      'Agent Knowledge status route',
      `${connectedHostBaseUrl}${AGENT_KNOWLEDGE_ROUTE}/status`,
      token,
      {
        validate: validateAgentKnowledgeJsonRoute(`${AGENT_KNOWLEDGE_ROUTE}/status`, 'Agent Knowledge status route'),
      },
    ),
  );

  checks.push(
    await fetchJsonCheck(
      'agent-knowledge-ask-isolated',
      'Agent Knowledge ask route',
      `${connectedHostBaseUrl}${AGENT_KNOWLEDGE_ROUTE}/ask`,
      token,
      {
        method: 'POST',
        body: {
          query: 'What is GoodVibes Agent?',
          limit: 5,
          mode: 'concise',
          includeSources: true,
          includeConfidence: true,
          includeLinkedObjects: true,
        },
        validate: validateAgentKnowledgeJsonRoute(`${AGENT_KNOWLEDGE_ROUTE}/ask`, 'Agent Knowledge ask route'),
      },
    ),
  );

  checks.push(await checkAgentKnowledgeIsolation(connectedHostBaseUrl, token));

  for (const check of AGENT_KNOWLEDGE_READ_ROUTE_CHECKS) {
    checks.push(
      await fetchJsonCheck(check.id, check.title, `${connectedHostBaseUrl}${check.route}`, token, {
        validate: validateAgentKnowledgeJsonRoute(check.route, check.title),
      }),
    );
  }

  const counts = countStatuses(checks);
  // A skipped check verified nothing: strict mode does not accept one, so a
  // missing token cannot turn the isolation checks into a PASS.
  const ok = counts.fail === 0 && (!options.strict || (counts.warn === 0 && counts.skip === 0));
  return sanitizeLiveVerificationReport(
    {
      generatedAt: new Date().toISOString(),
      homeDir,
      binaryPath,
      connectedHostBaseUrl,
      strict: options.strict ?? false,
      checks,
      counts,
      ok,
    },
    { homeDir, userHomeDir: dirname(homeDir), realHomeDir: homedir(), projectRoot, binaryPath, tokens: token ? [token] : undefined },
  );
}

export function sanitizeLiveVerificationReport(
  report: LiveVerificationReport,
  context: LiveVerificationRedactionContext,
): LiveVerificationReport {
  return {
    ...report,
    homeDir: '[goodvibes-home]',
    binaryPath: '[agent-binary]',
    connectedHostBaseUrl: redactForReleaseArtifact(report.connectedHostBaseUrl, context),
    checks: report.checks.map((check) => ({
      ...check,
      summary: redactForReleaseArtifact(check.summary, context),
      detail: check.detail === undefined ? undefined : redactForReleaseArtifact(check.detail, context),
    })),
  };
}

export function renderLiveVerificationReportMarkdown(report: LiveVerificationReport): string {
  // Defense-in-depth: redact header values even if the report was not pre-sanitized.
  // sanitizeLiveVerificationReport already replaces these with placeholders for normal
  // usage, but an unsanitized report passed directly must not leak local paths.
  // normalizeRenderedPath: if the value still looks like a raw filesystem path (starts with /
  // or ~) replace it with the canonical sanitized placeholder so the renderer cannot echo
  // a raw path even when called without prior sanitization.
  function normalizeRenderedPath(value: string, placeholder: string): string {
    const stripped = redactPrivateNetworkAddresses(redact(value));
    return /^[/~]/.test(stripped) ? placeholder : stripped;
  }
  const homeDir = normalizeRenderedPath(report.homeDir, '[goodvibes-home]');
  const binaryPath = normalizeRenderedPath(report.binaryPath, '[agent-binary]');
  const connectedHostBaseUrl = redactPrivateNetworkAddresses(redact(report.connectedHostBaseUrl));
  return renderVerificationTables(
    [
      '# GoodVibes Agent Live Verification',
      '',
      `Generated: ${report.generatedAt}`,
      `Home: \`${homeDir}\``,
      `Binary: \`${binaryPath}\``,
      `Connected host: \`${connectedHostBaseUrl}\``,
      '',
    ],
    report,
  );
}

export function writeLiveVerificationReportFiles(report: LiveVerificationReport, outputDir: string): void {
  writeVerificationReportFiles(report, outputDir, renderLiveVerificationReportMarkdown);
}

/**
 * The Cloud-project half of the OAuth path: gcloud and the console pages.
 *
 * Split out of `setup-actions.ts` because it answers a different question. That
 * module binds step ids to runners and owns the consent exchange; these six
 * steps are about the PROJECT the OAuth client will live in, is gcloud there,
 * is it signed in, which project, which APIs, is the consent screen filled in,
 * is the app published. None of it runs on a machine that already has a client,
 * which is the whole point of the `existing-client` path.
 *
 * Every one of these is scriptable through gcloud except the two Google exposes
 * no API for: the consent screen and the audience/publishing setting. The
 * consent screen is recognised as done from evidence (a stored client, or an
 * audience page that shows a publishing status, which Google shows only once
 * the consent screen exists); only when neither is there does it stop and say
 * exactly what to fill in.
 */

import {
  AUTH_CLIENTS_URL,
  GOOGLE_CONFIG_KEYS,
  GOOGLE_SECRET_KEYS,
  REQUIRED_SERVICES,
} from './setup-plan.js';
import { readGoogleSecretState } from './setup-state.js';
import type { GoogleStepRunner, GoogleStepRunnerResult } from './setup-flow.js';
import type { GoogleStepId } from './types.js';
import type { GoogleSetupActionDeps } from './setup-action-deps.js';
import { publishApp, readPublishingStatus, type PublishingStatus } from './console-flow.js';
import {
  checkAuthenticated,
  detectGcloud,
  enableServices,
  enabledServices,
  installGcloud,
  selectOrCreateProject,
} from './gcloud.js';
import { safeConfigString } from './config-access.js';

/** Cloud project ids this flow will reuse. Keeps re-runs from piling up projects. */
const GOOGLE_PROJECT_PREFIX = 'goodvibes-agent';

function done(detail: string): GoogleStepRunnerResult {
  return { outcome: 'done', detail };
}

function alreadyDone(detail: string): GoogleStepRunnerResult {
  return { outcome: 'already-done', detail };
}

function needsHuman(detail: string, problem: string, fix: string): GoogleStepRunnerResult {
  return { outcome: 'needs-human', detail, problem, fix };
}

function failed(detail: string, problem: string, fix: string): GoogleStepRunnerResult {
  return { outcome: 'failed', detail, problem, fix };
}

interface GcloudState {
  path: string | null;
  /** The publishing status the consent-screen step read this run, so the audience step does not read it again. */
  publishing: Exclude<PublishingStatus, 'unknown'> | null;
}

function gcloudInstalledRunner(deps: GoogleSetupActionDeps, state: GcloudState): GoogleStepRunner {
  return async () => {
    const detection = await detectGcloud(deps.commands, deps.homeDirectory);
    if (detection.ok) {
      state.path = detection.path;
      return alreadyDone(`gcloud is already installed (${detection.version}).`);
    }
    const install = await installGcloud(deps.commands, { homeDirectory: deps.homeDirectory });
    if (!install.ok) {
      return failed('gcloud could not be installed.', install.problem, install.fix);
    }
    state.path = install.path;
    return install.outcome === 'already-installed'
      ? alreadyDone('gcloud is already installed.')
      : done(`Installed gcloud into ${install.path}.`);
  };
}

/**
 * Where gcloud is. The installed step records it, but a step that runs in a
 * later process (a resumed flow skips the installed step as already done)
 * finds `state.path` empty: look again, so a gcloud the installer put under
 * the home directory is still found instead of falling back to a bare name
 * that is not on PATH.
 */
async function gcloudPath(deps: GoogleSetupActionDeps, state: GcloudState): Promise<string> {
  if (state.path === null) {
    const detection = await detectGcloud(deps.commands, deps.homeDirectory);
    if (detection.ok) state.path = detection.path;
  }
  return state.path ?? 'gcloud';
}

function gcloudAuthRunner(deps: GoogleSetupActionDeps, state: GcloudState): GoogleStepRunner {
  return async () => {
    const check = await checkAuthenticated(deps.commands, await gcloudPath(deps, state));
    if (check.ok) {
      return alreadyDone(`gcloud is signed in as ${check.account}.`);
    }
    return needsHuman(
      'gcloud is not signed in.',
      'gcloud needs its own sign-in before it can create a project or enable APIs, and it opens its own browser to do it.',
      'Run: gcloud auth login, choose the Google account you want the agent to use, then re-run this flow.',
    );
  };
}

function gcloudProjectRunner(deps: GoogleSetupActionDeps, state: GcloudState): GoogleStepRunner {
  return async () => {
    // The prefix is what makes this idempotent: an existing goodvibes project
    // is reused rather than a second one piling up on every re-run.
    const result = await selectOrCreateProject(deps.commands, await gcloudPath(deps, state), {
      preferredPrefix: GOOGLE_PROJECT_PREFIX,
    });
    if (!result.ok) {
      return failed('No Cloud project could be selected.', result.problem, result.fix);
    }
    deps.config.set(GOOGLE_CONFIG_KEYS.oauthProjectId, result.projectId);
    return result.outcome === 'reused'
      ? alreadyDone(`Reusing the existing Cloud project ${result.projectId}.`)
      : done(`Created the Cloud project ${result.projectId}.`);
  };
}

function apisEnabledRunner(deps: GoogleSetupActionDeps, state: GcloudState): GoogleStepRunner {
  return async () => {
    const projectId = safeConfigString(deps.config, GOOGLE_CONFIG_KEYS.oauthProjectId);
    if (projectId === null) {
      return failed(
        'No Cloud project is recorded.',
        'The project step did not record a project id, so there is nothing to enable APIs on.',
        'Re-run the flow so the project step runs first.',
      );
    }
    const already = await enabledServices(deps.commands, await gcloudPath(deps, state), projectId);
    if (already.ok && REQUIRED_SERVICES.every((service) => already.services.includes(service))) {
      return alreadyDone(`Already enabled: ${REQUIRED_SERVICES.join(', ')}.`);
    }
    const result = await enableServices(deps.commands, await gcloudPath(deps, state), projectId, REQUIRED_SERVICES);
    if (!result.ok) {
      return failed('The required Google APIs could not be enabled.', result.problem, result.fix);
    }
    return result.enabled.length === 0
      ? alreadyDone(`Already enabled: ${result.alreadyEnabled.join(', ')}.`)
      : done(`Enabled ${result.enabled.join(', ')} on ${projectId}.`);
  };
}

/**
 * The consent screen. Google exposes no API for it, so whether it is filled in
 * is read from evidence: a stored client (Google creates one only after the
 * consent screen exists), or the audience page showing a publishing status
 * (it shows none until the consent screen exists). Only when neither is there
 * does the run stop at the branding page, and then a re-run finds the
 * evidence and goes on.
 */
function brandingRunner(deps: GoogleSetupActionDeps, state: GcloudState): GoogleStepRunner {
  return async (spec) => {
    const clientId = safeConfigString(deps.config, GOOGLE_CONFIG_KEYS.oauthClientId);
    if (clientId !== null && await readGoogleSecretState(deps.secrets, GOOGLE_SECRET_KEYS.oauthClientSecret) === 'present') {
      return alreadyDone('An OAuth client is stored, which Google allows only once the consent screen is filled in.');
    }
    const browser = await deps.browser();
    const status = await readPublishingStatus(browser);
    if (status.kind === 'ok' && status.status !== 'unknown') {
      state.publishing = status.status;
      deps.config.set(GOOGLE_CONFIG_KEYS.oauthPublishingStatus, status.status);
      return alreadyDone('The consent screen is filled in: the Google Auth Platform shows this app\'s publishing status.');
    }
    // A sign-in wall or an unselected project says nothing about the
    // consent screen; it is what stands in the way, so it is what is asked.
    if (status.kind === 'needs-human') {
      return needsHuman('The Google Auth Platform console could not be read yet.', status.problem, status.fix);
    }
    if (spec.url !== undefined) await browser.navigate(spec.url);
    return needsHuman(
      'The OAuth consent screen needs filling in.',
      'Google exposes no API for the consent screen, so it has to be completed in the browser once.',
      `The browser is open at ${spec.url ?? 'the branding page'}. Fill in the app name and your support email, choose the "External" audience and click "Create". Then re-run: the consent screen is recognised from the console and the run carries on. If you create the Desktop client yourself at ${AUTH_CLIENTS_URL}, enter it with /google client <client-id> <client-secret> instead.`,
    );
  };
}

/**
 * Publishing status. This is the step that decides whether the credential
 * survives a week, so it is read from the console rather than assumed, and a
 * `testing` status is carried out as a loud warning even when the run succeeds.
 */
function audienceProductionRunner(deps: GoogleSetupActionDeps, state: GcloudState): GoogleStepRunner {
  return async () => {
    const browser = await deps.browser();
    // Read once per run: the consent-screen step may already have read it.
    let current = state.publishing;
    if (current === null) {
      const status = await readPublishingStatus(browser);
      if (status.kind === 'needs-human') {
        return needsHuman('The publishing status could not be read.', status.problem, status.fix);
      }
      if (status.kind === 'failed') {
        return failed('The publishing status could not be read.', status.problem, status.fix);
      }
      current = status.status === 'unknown' ? null : status.status;
    }
    if (current === 'in-production') {
      deps.config.set(GOOGLE_CONFIG_KEYS.oauthPublishingStatus, 'in-production');
      return alreadyDone('The app is already published, so its refresh token does not expire.');
    }

    const published = await publishApp(browser);
    if (published.kind === 'needs-human') {
      deps.config.set(GOOGLE_CONFIG_KEYS.oauthPublishingStatus, 'testing');
      return needsHuman('The app is still in Testing.', published.problem, published.fix);
    }
    if (published.kind === 'failed') {
      deps.config.set(GOOGLE_CONFIG_KEYS.oauthPublishingStatus, 'testing');
      return failed('The app could not be published.', published.problem, published.fix);
    }
    deps.config.set(GOOGLE_CONFIG_KEYS.oauthPublishingStatus, 'in-production');
    return done('Published the app, so the refresh token it issues does not expire after seven days.');
  };
}

/**
 * Bind the six project-and-console steps.
 *
 * The `GcloudState` is created here and shared across them, so the executable
 * that answered `--version` is the one every later call uses rather than each
 * step re-detecting it.
 */
export function buildCloudProjectRunners(
  deps: GoogleSetupActionDeps,
): ReadonlyMap<GoogleStepId, GoogleStepRunner> {
  const state: GcloudState = { path: null, publishing: null };
  return new Map<GoogleStepId, GoogleStepRunner>([
    ['gcloud-installed', gcloudInstalledRunner(deps, state)],
    ['gcloud-authenticated', gcloudAuthRunner(deps, state)],
    ['gcloud-project', gcloudProjectRunner(deps, state)],
    ['apis-enabled', apisEnabledRunner(deps, state)],
    ['oauth-branding', brandingRunner(deps, state)],
    ['oauth-audience-production', audienceProductionRunner(deps, state)],
  ]);
}

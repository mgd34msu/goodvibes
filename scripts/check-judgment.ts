/** Verify the installed account's Jev connection before declaring setup complete. */
import { resolve } from 'node:path';
import { ConfigManager } from '../packages/engine/platform/dist/platform/config/manager.js';
import { createRuntimeSecretsManager } from '../packages/engine/platform/dist/platform/runtime/secrets-composition.js';
import { createSettingsJudgmentPort } from '../packages/engine/platform/dist/platform/runtime/judgment-services.js';
import { decisionModelSet, decisionModelSettings } from '../packages/engine/platform/dist/platform/config/decision-model-set.js';
import { requestedDecisionModel } from '../packages/engine/platform/dist/platform/config/decision-model-request.js';
// The same module the engine loads (packages/engine/node_modules/@goodvibes/judgment links here),
// so the failure it describes is recognised as a decision-model failure.
import { decisionModelFailureMessage, describeDecisionModelFailure } from '../packages/judgment/src/port/model-failure.ts';

let model = '';
try {
  const homeDirectory = resolve(process.argv[2]!);
  const config = new ConfigManager({ homeDir: homeDirectory, workingDir: homeDirectory, surfaceRoot: 'tui', readOnly: true });
  // The same fact composeJudgment reads: whether any decision model is set.
  if (!decisionModelSet(decisionModelSettings(key => config.get(key)), process.env)) {
    console.log('No decision model selected; no decision-model connection is required or certified.');
  } else {
    model = requestedDecisionModel(config.get('judgment.model'), process.env);
    const secrets = createRuntimeSecretsManager({ projectRoot: homeDirectory, globalHome: homeDirectory, surfaceRoot: 'tui',
      configManager: config, daemonHome: resolve(homeDirectory, '.goodvibes/daemon') });
    const port = createSettingsJudgmentPort({ config, secrets, env: process.env });
    await port.ask({ state: 'The GoodVibes installation is checking its connection to Jev.',
      questions: { connected: { type: 'noul', instructions: 'Does the state describe an installation checking its connection?' } },
      signal: AbortSignal.timeout(30_000) });
    console.log('Decision-model connection verified.');
  }
} catch (error) {
  const failure = describeDecisionModelFailure(model, error);
  if (failure !== undefined) {
    console.error(`Jev setup failed: ${decisionModelFailureMessage(failure)}`);
  } else {
    const next = error !== null && typeof error === 'object' && 'status' in error && error.status === 402
      ? 'Add credits or update billing for the TypeSafe account at https://console.typesafe.ai/settings/billing.'
      : 'Check the Jev endpoint and TYPESAFE_API_KEY in the installation environment file.';
    console.error(`Jev setup failed: ${error instanceof Error ? error.message : String(error)}. ${next}`);
  }
  process.exitCode = 1;
}

// Contract artifacts are generated from package source and committed so release
// packages can expose stable JSON contracts without running generators at
// install time. This script is the CI/local check-mode wrapper for that refresh.
if (!process.argv.includes('--check')) {
  process.argv.push('--check');
}

await import('./refresh-contract-artifacts.ts');

// refresh-contract-artifacts.ts never touches
// contracts/src/generated/foundation-client-types.ts (it only
// regenerates operator-contract/operator-method-ids/peer-contract/
// peer-endpoint-ids/foundation-metadata). That file's input/output maps are
// written by scripts/generate-foundation-io-entries.ts from the method catalog;
// run the consistency check here so `contracts:check` stays the one gate that
// catches drift in either generated surface.
await import('./check-foundation-io-types.ts');

// The published OpenAPI 3.1 operator contract is generated from the committed
// operator-contract.json. Same gate, same idiom: drift in
// contracts/artifacts/operator-openapi.json reddens `contracts:check`.
await import('./generate-openapi-contract.ts');

// The small agent-facing spec is derived from the same contract. This only
// reads: the module runs in check mode here (--check is on argv above), so a
// stale docs/agent-api.openapi.json reddens `contracts:check` and nothing is
// written by any gate.
await import('./generate-agent-spec.ts');

// docs/reference-*.md are rendered from the same committed contracts; in check
// mode a stale reference document throws here instead of being written.
await import('./generate-api-docs.ts');

// The generated consumer transport layers (Stage C): the webui mechanical
// facade (contracts/src/generated/webui-facade.ts) and the Home
// Assistant Python client (contracts/artifacts/python/
// homeassistant_operator_client.py), both emitted from the committed
// operator-contract.json. Same gate, same drift idiom, a stale generated
// consumer layer reddens `contracts:check`.
const { generateWebuiFacade } = await import('./generate-webui-facade.ts');
const { generateHomeassistantClient } = await import('./generate-homeassistant-client.ts');
let consumerDrift = false;
consumerDrift = generateWebuiFacade({ check: true }) || consumerDrift;
consumerDrift = generateHomeassistantClient({ check: true }) || consumerDrift;
if (consumerDrift) {
  console.error('[contracts:check] generated consumer transport drift, run `bun run refresh:contracts`');
  process.exit(1);
}

// The slash commands' actions as data for the web UI's sheets
// (contracts/artifacts/command-actions.json), from the command descriptions:
// stale, or naming an operator method the contract lacks, reddens the gate.
const commandActions = Bun.spawnSync(['bun', 'packages/engine/scripts/generate-command-actions.ts', '--check'], { stdout: 'inherit', stderr: 'inherit' });
if (commandActions.exitCode !== 0) process.exit(1);

#!/usr/bin/env bun
import {
  buildLiveVerificationReport,
  renderLiveVerificationReportMarkdown,
  writeLiveVerificationReportFiles,
} from '../src/verification/live-verifier.ts';
import { join, resolve } from 'node:path';
import { liveVerificationPasses, resolveVerifyLiveHome } from './verify-live-options.ts';

function readArgValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

const args = process.argv.slice(2);
const connectedHostBaseUrl = readArgValue(args, '--connected-host-url')
  ?? readArgValue(args, '--runtime-url')
  ?? readArgValue(args, '--daemon-url');

if (args.includes('--help') || args.includes('-h')) {
  console.log([
    'Usage: bun run scripts/verify-live.ts [options]',
    '',
    'Options:',
    '  --home <path>        The .goodvibes directory. Defaults to the tree under',
    '                       GOODVIBES_HOME, or ~/.goodvibes when that is unset.',
    '  --binary <path>      Compiled goodvibes-agent binary. Defaults to dist/goodvibes-agent.',
    '  --connected-host-url <url>',
    '                      Connected host base URL. Defaults to configured control-plane port on 127.0.0.1.',
    '  --runtime-url <url> Alias for --connected-host-url.',
    '  --strict            Treat warnings and skipped checks as failures.',
    '  --json              Print JSON instead of Markdown.',
    '  --out <dir>         Write live-verification.{json,md} to a directory.',
    '  --help              Show this help.',
    '',
    'The Agent Knowledge isolation check writes two small probe sources to the',
    'connected host, one through the Agent Knowledge ingest route and one through',
    'the default knowledge ingest route, both tagged live-verification, and needs',
    'an operator token that may write knowledge. The probes stay on the host.',
  ].join('\n'));
  process.exit(0);
}

const report = await buildLiveVerificationReport({
  homeDir: resolveVerifyLiveHome(readArgValue(args, '--home')),
  binaryPath: readArgValue(args, '--binary') ?? join(resolve(join(import.meta.dir, '..')), 'dist', 'goodvibes-agent'),
  projectRoot: resolve(join(import.meta.dir, '..')),
  connectedHostBaseUrl,
  strict: args.includes('--strict'),
});

const outputDir = readArgValue(args, '--out');
if (outputDir) {
  writeLiveVerificationReportFiles(report, outputDir);
}

console.log(args.includes('--json')
  ? JSON.stringify(report, null, 2)
  : renderLiveVerificationReportMarkdown(report));

if (!liveVerificationPasses(report)) {
  if (report.strict && report.counts.fail === 0 && report.counts.skip > 0) console.error(`verify-live: ${report.counts.skip} check(s) were skipped, which --strict does not accept.`);
  process.exit(1);
}
process.exit(0);

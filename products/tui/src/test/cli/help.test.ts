import { describe, expect, test } from 'bun:test';
import { renderGoodVibesCommandHelp, renderGoodVibesVersion } from '../../cli/help.ts';
import { VERSION } from '../../version.ts';

describe('CLI help/version', () => {
  test('does not report the consuming project npm_package_version', () => {
    const previous = process.env.npm_package_version;
    // Sentinel that can never equal the real build version, the original
    // test used '1.0.0', which collided with reality at the v1.0.0 release
    // and failed the release validate job.
    const sentinel = '99.99.99-npm-env-sentinel';
    process.env.npm_package_version = sentinel;

    try {
      const rendered = renderGoodVibesVersion();
      expect(rendered).not.toBe(`goodvibes ${sentinel}`);
      expect(rendered).toBe(`goodvibes ${VERSION}`);
    } finally {
      if (previous === undefined) {
        delete process.env.npm_package_version;
      } else {
        process.env.npm_package_version = previous;
      }
    }
  });

  test('renderGoodVibesVersion never renders the 0.0.0 placeholder', () => {
    // The name-guard in getPackageVersion() means a stray package.json can never
    // leak "0.0.0" into the version string; the resolved value is the real
    // prebuild-baked VERSION.
    expect(renderGoodVibesVersion('goodvibes-daemon')).toBe(`goodvibes-daemon ${VERSION}`);
    expect(renderGoodVibesVersion('goodvibes-daemon')).not.toContain('0.0.0');
  });
});

describe('command help pages for advertised commands', () => {
  test('host pair has a detail page that names its review and apply options', () => {
    const help = renderGoodVibesCommandHelp('host');
    expect(help).toContain('Usage:');
    expect(help).toContain('host pair');
    expect(help).toContain('--apply');
    expect(help).not.toContain('No detailed help');
  });

  test('auth help lists the account-recovery subcommands the handler implements', () => {
    const help = renderGoodVibesCommandHelp('auth');
    for (const sub of ['rotate-password', 'delete-user', 'revoke-session', 'revoke-sessions', '--password-stdin', '--role']) expect(help).toContain(sub);
  });
});

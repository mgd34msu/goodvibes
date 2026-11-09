/** Agent fixtures adapt the platform's shared native release fixture. */
import { terminalFixturePayload, installTerminalFixture, terminalFixtureRelease } from '../../../../../packages/engine/test/_helpers/suite-release-fixture.ts';
export { fixtureDigest, suiteArchive as fixtureTarGz } from '../../../../../packages/engine/test/_helpers/suite-release-fixture.ts';
export function agentFixturePayload(platform: NodeJS.Platform, arch: string, version: string, source: string) {
  return terminalFixturePayload('goodvibes-agent', platform, arch, version, source);
}
export function installAgentFixture(root: string, platform: NodeJS.Platform, arch: string, version: string, source: string) {
  return installTerminalFixture(root, 'goodvibes-agent', platform, arch, version, source);
}
export function agentFixtureRelease(platform: NodeJS.Platform, arch: string, version: string, source: string) {
  return terminalFixtureRelease('goodvibes-agent', platform, arch, version, source);
}

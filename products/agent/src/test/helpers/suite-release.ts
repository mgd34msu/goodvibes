/** Agent fixtures adapt the platform's shared native release fixture. */
import { terminalFixturePayload, installTerminalFixture, terminalFixtureRelease } from '@goodvibes-jev/engine/toolchain/testing/suite-release';
export { fixtureDigest, suiteArchive as fixtureTarGz } from '@goodvibes-jev/engine/toolchain/testing/suite-release';
export function agentFixturePayload(platform: NodeJS.Platform, arch: string, version: string, source: string) {
  return terminalFixturePayload('goodvibes-agent', platform, arch, version, source);
}
export function installAgentFixture(root: string, platform: NodeJS.Platform, arch: string, version: string, source: string) {
  return installTerminalFixture(root, 'goodvibes-agent', platform, arch, version, source);
}
export function agentFixtureRelease(platform: NodeJS.Platform, arch: string, version: string, source: string) {
  return terminalFixtureRelease('goodvibes-agent', platform, arch, version, source);
}

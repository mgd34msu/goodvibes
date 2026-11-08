/** Let the release fixture execute the actual command handler without a build. */
import { runDaemonCli } from '../../products/daemon/src/cli/run.js';
process.exitCode = await runDaemonCli(process.argv.slice(2), {
  createRuntime: async () => { throw new Error('Installer reader inspection must not construct a runtime'); },
});

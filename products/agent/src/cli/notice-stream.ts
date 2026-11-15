/**
 * Where a one-time startup notice is printed. A notice must never sit ahead of
 * machine-readable stdout, so `run` and any non-text output format send it to
 * stderr.
 */
export function startupNoticeWriter(
  cli: { readonly command: string | undefined; readonly flags: { readonly outputFormat?: string | undefined } },
  streams: { readonly out: (message: string) => void; readonly err: (message: string) => void },
): (message: string) => void {
  const machineReadable = cli.command === 'run' || (cli.flags.outputFormat !== undefined && cli.flags.outputFormat !== 'text');
  return machineReadable ? streams.err : streams.out;
}

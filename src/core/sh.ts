type Options = { stdin?: string; timeoutMs?: number };

export async function run(cmd: string[], opts: Options = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(cmd, {
    stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: opts.timeoutMs ?? 60_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

export async function runOk(cmd: string[], opts?: Options): Promise<string> {
  const { stdout, stderr, code } = await run(cmd, opts);
  if (code !== 0) throw new Error(`${cmd[0]} exited with code ${code}: ${stderr || stdout}`);
  return stdout;
}

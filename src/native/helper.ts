import path from 'node:path';
import { run } from '../core/sh';

const HELPER = path.join(import.meta.dir, '..', '..', 'bin', 'ax-helper');

export type AxResult = { ok: boolean; role?: string; name?: string; error?: string };

export async function runHelper<T>(args: string[], stdin?: string): Promise<T> {
  if (!(await Bun.file(HELPER).exists())) {
    throw new Error('bin/ax-helper is missing. Build it with: bun run build:ax');
  }
  const { stdout, stderr, code } = await run([HELPER, ...args], { stdin, timeoutMs: 30_000 });
  let parsed: { error?: string };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ax-helper ${args[0]} failed: ${(stderr || stdout).slice(0, 300)}`);
  }
  if (code !== 0 || parsed.error) throw new Error(parsed.error ?? `ax-helper ${args[0]} failed`);
  return parsed as T;
}

export const frontmostApp = () => runHelper<{ name: string; bundleId: string }>(['frontmost']);

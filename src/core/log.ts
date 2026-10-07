import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const LOG_DIR = path.join(import.meta.dir, '..', '..', 'logs');
export const SHOT_DIR = path.join(LOG_DIR, 'shots');
const AGENT_LOG = path.join(LOG_DIR, 'agent.jsonl');

await mkdir(SHOT_DIR, { recursive: true });

type Entry = Record<string, unknown>;

export async function log(entry: Entry): Promise<void> {
  await appendFile(AGENT_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

export async function logged(tool: string, info: Entry, run: () => Promise<string>): Promise<string> {
  try {
    const output = await run();
    await log({ tool, ...info, outputChars: output.length });
    return output;
  } catch (err) {
    await log({ tool, ...info, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

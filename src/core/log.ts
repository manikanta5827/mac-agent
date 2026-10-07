import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const LOG_DIR = path.join(import.meta.dir, '..', '..', 'logs');
export const SHOT_DIR = path.join(LOG_DIR, 'shots');
const AGENT_LOG = path.join(LOG_DIR, 'agent.jsonl');

// create the screenshots directory to store the screenshots
await mkdir(SHOT_DIR, { recursive: true });

// log an entry to the file
export async function log(entry: Record<string, unknown>): Promise<void> {
  await appendFile(AGENT_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

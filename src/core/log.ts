import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const LOG_DIR = path.join(import.meta.dir, '..', '..', 'logs');
export const SHOT_DIR = path.join(LOG_DIR, 'shots');
const AGENT_LOG = path.join(LOG_DIR, 'agent.jsonl');
const CONVERSATION_LOG = path.join(LOG_DIR, 'conversations', `${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.jsonl`);

await mkdir(SHOT_DIR, { recursive: true });
await mkdir(path.dirname(CONVERSATION_LOG), { recursive: true });

type Entry = Record<string, unknown>;

async function write(file: string, entry: Entry): Promise<void> {
  await appendFile(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

export const log = (entry: Entry) => write(AGENT_LOG, entry);
export const logConversation = (entry: Entry) => write(CONVERSATION_LOG, entry);

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

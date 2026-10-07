import { run } from '../core/sh';

// constants of the agent browser cli
const BIN = process.env.AGENT_BROWSER_BIN ?? Bun.which('agent-browser');
const SESSION = 'mac-agent';
const CHROME_PROFILE = 'Default';
const CHROME_APP = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAX_OUTPUT_CHARS = 25_000;
export const RAW_SNAPSHOT_CHARS = 400_000;
export const PART_CHARS = 20_000;

// text for replacing the ignored warning
const IGNORED_WARNING = /^.*ignored: daemon already running.*$\n?/gm;

// run the browser cli commands
export async function browser(args: string[], maxOutput = MAX_OUTPUT_CHARS): Promise<string> {
  if (!BIN) throw new Error('agent-browser not found. Set AGENT_BROWSER_BIN in .env to the agent-browser binary path.');
  const { stdout, stderr, code } = await run([
    BIN, '--session', SESSION, '--profile', CHROME_PROFILE, '--executable-path', CHROME_APP, '--headed',
    '--max-output', String(maxOutput), ...args,
  ]);
  const out = stdout.replace(IGNORED_WARNING, '').trim();
  const err = stderr.replace(IGNORED_WARNING, '').trim();
  if (code !== 0) throw new Error(`agent-browser ${args[0]} failed: ${err || out}`);
  return out;
}

// trim the snapshot to the relevant text
const DECORATION_ROLES = new Set(['image', 'img', 'figure', 'LineBreak', 'strong', 'emphasis', 'separator']);
const WRAPPER_ROLES = new Set(['generic', 'paragraph', 'group', 'list', 'listitem', 'section', 'none']);
const MAX_TEXT_CHARS = 240;
const LONG_TEXT_REGEX = new RegExp(`"([^"]{${MAX_TEXT_CHARS}})[^"]+"`, 'g');

// trim the snapshot
export function trimSnapshot(text: string): string {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^(\s*)- (\w+)(.*)$/);
    if (!match) {
      out.push(line);
      continue;
    }
    const [, indent, role, rest] = match as unknown as [string, string, string, string];
    const hasRef = rest.includes('ref=');
    const hasOwnText = rest.trim().replace(/[:\[\]]/g, '') !== '';
    if (!hasRef && DECORATION_ROLES.has(role)) continue;
    if (!hasRef && !hasOwnText && WRAPPER_ROLES.has(role)) continue;
    const trimmed = role === 'StaticText' ? `${indent}- ${rest.trim()}` : line;
    out.push(trimmed.replace(LONG_TEXT_REGEX, '"$1…"'));
  }
  return out.join('\n');
}

export function safeArg(value: string): string {
  if (/^-\S/.test(value)) throw new Error(`Text may not start with "-" followed by a letter: ${value.slice(0, 20)}`);
  return value;
}

export function toRef(ref: string): string {
  const match = ref.trim().match(/^@?(e\d+)$/);
  if (!match) throw new Error(`"${ref}" is not a ref. Use a ref from the latest browser_snapshot, like @e12.`);
  return `@${match[1]}`;
}

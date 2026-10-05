
const BIN = process.env.AGENT_BROWSER_BIN ?? Bun.which('agent-browser');
const SESSION = 'mac-agent';
const CHROME_PROFILE = 'Default';
const CHROME_APP = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAX_OUTPUT_CHARS = 25_000;
const RAW_SNAPSHOT_CHARS = 400_000;
const SNAPSHOT_LIMIT_CHARS = 20_000;

const IGNORED_WARNING = /^.*ignored: daemon already running.*$\n?/gm;

export async function browser(args: string[], maxOutput = MAX_OUTPUT_CHARS): Promise<string> {
  if (!BIN) throw new Error('agent-browser not found. Set AGENT_BROWSER_BIN in .env to the agent-browser binary path.');
  const cmd = [
    BIN, '--session', SESSION, '--profile', CHROME_PROFILE, '--executable-path', CHROME_APP, '--headed',
    '--max-output', String(maxOutput), ...args,
  ];
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const out = stdout.replace(IGNORED_WARNING, '').trim();
  const err = stderr.replace(IGNORED_WARNING, '').trim();
  if (code !== 0) throw new Error(`agent-browser ${args[0]} failed: ${err || out}`);
  return out;
}

const DECORATION_ROLES = new Set(['image', 'img', 'figure', 'LineBreak', 'strong', 'emphasis', 'separator']);
const WRAPPER_ROLES = new Set(['generic', 'paragraph', 'group', 'list', 'listitem', 'section', 'none']);
const MAX_TEXT_CHARS = 240;

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
    out.push(trimmed.replace(new RegExp(`"([^"]{${MAX_TEXT_CHARS}})[^"]+"`, 'g'), '"$1…"'));
  }
  return out.join('\n');
}

export function splitIntoParts(text: string, limit: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > limit) {
      parts.push(current);
      current = '';
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) parts.push(current);
  return parts;
}

export async function browserSnapshot(part = 1): Promise<string> {
  const raw = await browser(['snapshot', '-c'], RAW_SNAPSHOT_CHARS);
  const parts = splitIntoParts(trimSnapshot(raw.replace(/\n\[truncated:[^\]]*\]\s*$/, '')), SNAPSHOT_LIMIT_CHARS);
  if (parts.length <= 1) return parts[0] ?? '(empty page)';
  const index = Math.min(Math.max(part, 1), parts.length) - 1;
  const more = index + 1 < parts.length ? ` For the next part, call browser_snapshot with part ${index + 2}.` : '';
  return `[page part ${index + 1} of ${parts.length}.${more}]\n${parts[index]}`;
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

// Executor for Chrome: runs the agent-browser CLI (https://github.com/vercel-labs/agent-browser).
//
// Instead of pixels, agent-browser reads the page structure (accessibility tree) and gives every
// element a ref like @e12. The model says "click @e12" and agent-browser clicks exactly that element.
//
// Logins: agent-browser copies your main Chrome profile ("Default") to a temp folder and starts a
// separate Chrome window with that copy, so you are already logged in (LinkedIn etc.). Your real
// profile is never changed, and your normal Chrome does not need remote debugging turned on.
// It must use the installed Google Chrome: agent-browser's own bundled Chrome cannot decrypt your
// cookies (they are locked with Chrome's Keychain key), and you would land on login pages (tested).
// The copy is taken when this browser starts; new logins made inside it are not saved back.

// On some setups `agent-browser` is only a shell function (nvm lazy loading), which Bun cannot run.
// Then set AGENT_BROWSER_BIN to the real binary path in .env.
const BIN = process.env.AGENT_BROWSER_BIN ?? Bun.which('agent-browser');
const SESSION = 'mac-agent';
const CHROME_PROFILE = 'Default'; // see `agent-browser profiles`
const CHROME_APP = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MAX_OUTPUT_CHARS = 25_000;      // cap for normal command output
const RAW_SNAPSHOT_CHARS = 400_000;   // let agent-browser return the whole page; we trim it ourselves
const SNAPSHOT_LIMIT_CHARS = 20_000;  // what the model gets after trimming (~5k tokens)

// Launch options only apply when the browser starts; afterwards agent-browser prints this warning. Hide it.
const IGNORED_WARNING = /^.*ignored: daemon already running.*$\n?/gm;

/** Runs `agent-browser <args>` in the agent's own Chrome window and returns its output. Throws on failure. */
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

// Lines that are only decoration (no ref, no text of their own), e.g. "- image", "- LineBreak", "- generic".
const DECORATION_ROLES = new Set(['image', 'img', 'figure', 'LineBreak', 'strong', 'emphasis', 'separator']);
const WRAPPER_ROLES = new Set(['generic', 'paragraph', 'group', 'list', 'listitem', 'section', 'none']);
const MAX_TEXT_CHARS = 240;

/**
 * Makes a page snapshot smaller without losing refs or page text (about 30% smaller on LinkedIn):
 * drops decoration and empty wrapper lines, writes StaticText as plain "text", shortens very long texts.
 */
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

/** Splits text into parts of at most `limit` chars, cutting only at line ends. */
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

/**
 * Snapshot of the current tab: the whole page (a snapshot always covers the full page, not only the
 * visible area), trimmed, then split into parts that fit the model's limit. Returns part `part` (1-based).
 */
export async function browserSnapshot(part = 1): Promise<string> {
  const raw = await browser(['snapshot', '-c'], RAW_SNAPSHOT_CHARS);
  const parts = splitIntoParts(trimSnapshot(raw.replace(/\n\[truncated:[^\]]*\]\s*$/, '')), SNAPSHOT_LIMIT_CHARS);
  if (parts.length <= 1) return parts[0] ?? '(empty page)';
  const index = Math.min(Math.max(part, 1), parts.length) - 1;
  const more = index + 1 < parts.length ? ` For the next part, call browser_snapshot with part ${index + 2}.` : '';
  return `[page part ${index + 1} of ${parts.length}.${more}]\n${parts[index]}`;
}

/**
 * agent-browser reads anything that looks like an option (e.g. "--version") as its own flag,
 * even after "--" (tested). Refuse such text instead of silently doing something else.
 */
export function safeArg(value: string): string {
  if (/^-\S/.test(value)) throw new Error(`Text may not start with "-" followed by a letter: ${value.slice(0, 20)}`);
  return value;
}

/** Accepts "e12" or "@e12" and returns "@e12". */
export function toRef(ref: string): string {
  const match = ref.trim().match(/^@?(e\d+)$/);
  if (!match) throw new Error(`"${ref}" is not a ref. Use a ref from the latest browser_snapshot, like @e12.`);
  return `@${match[1]}`;
}

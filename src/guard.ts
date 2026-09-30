// Safety guard for keyboard and mouse input.
//
// The agent has no shell tool, but it types and clicks into whatever app is in front. If that app is a
// terminal (or anything that runs commands), typing becomes running commands, e.g. "rm -rf ~".
// A text filter alone is easy to get around (find -delete, mv, base64 | sh, typing in pieces), so the main
// protection is: no typing, key presses or clicks at all while a "dangerous" app is in front.
// Checked right before every input event, by bundle id (window titles can be anything).
//
// This is not a sandbox. The strongest protection is running the agent as a separate macOS user
// that has no access to your files.
import path from 'node:path';

const HELPER = path.join(import.meta.dir, '..', 'bin', 'ax-helper');

/** Apps where typing or clicking can run commands, change security settings, or reach secrets. */
const BLOCKED_BUNDLE_IDS = new Set([
  // terminals
  'com.apple.Terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'net.kovidgoyal.kitty',
  'org.alacritty', 'com.github.wez.wezterm', 'co.zeit.hyper', 'com.raphaelamorim.rio',
  // script and automation runners
  'com.apple.ScriptEditor2', 'com.apple.Automator', 'com.apple.shortcuts',
  // editors with a built-in terminal or AI agent that can run commands
  'com.microsoft.VSCode', 'com.todesktop.230313mzl4w4u92' /* Cursor */, 'com.exafunction.windsurf',
  'dev.zed.Zed', 'com.apple.dt.Xcode', 'com.anthropic.claudefordesktop', 'com.openai.chat',
  // security settings, passwords, processes
  'com.apple.systempreferences', 'com.apple.keychainaccess', 'com.1password.1password',
  'com.apple.ActivityMonitor',
]);
const BLOCKED_BUNDLE_PREFIXES = ['dev.warp.', 'com.jetbrains.'];

export function isBlockedApp(bundleId: string): boolean {
  return BLOCKED_BUNDLE_IDS.has(bundleId) || BLOCKED_BUNDLE_PREFIXES.some((prefix) => bundleId.startsWith(prefix));
}

/** Which app is in front right now: { name, bundleId }. */
async function frontmostApp(): Promise<{ name: string; bundleId: string }> {
  const proc = Bun.spawn([HELPER, 'frontmost'], { stdout: 'pipe', stderr: 'ignore', timeout: 5_000 });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(stdout);
}

/**
 * Throws unless it is safe to send keyboard/mouse input now. Fails closed: if the frontmost app cannot be
 * determined, input is refused.
 */
export async function assertInputAllowed(what: string): Promise<void> {
  let front: { name: string; bundleId: string };
  try {
    front = await frontmostApp();
  } catch {
    throw new Error(`Blocked ${what}: could not check which app is in front (is bin/ax-helper built?).`);
  }
  if (!front.bundleId || isBlockedApp(front.bundleId)) {
    throw new Error(
      `Blocked ${what}: "${front.name || 'unknown app'}" is in front, and input to terminals, script runners, ` +
      'code editors, AI apps and security settings is not allowed. Switch to the app you need with open_app first.',
    );
  }
}

/** Text that looks like a destructive or privileged shell command. Extra layer, not the main protection. */
const DANGEROUS_TEXT: [RegExp, string][] = [
  [/\brm\s+-|\brm\s+\S/i, 'rm (delete files)'],
  [/\bsudo\b/i, 'sudo'],
  [/\bmkfs\b|\bdiskutil\s+(erase|partition|zero|secure)/i, 'disk erase'],
  [/\bdd\s+if=/i, 'dd'],
  [/\bfind\b[^\n]*\s-delete\b/i, 'find -delete'],
  [/\bshred\b|\bsrm\b/i, 'secure delete'],
  [/\|\s*(ba|z|fi|k)?sh\b/i, 'piping into a shell'],
  [/\bchmod\s+-R\b|\bchown\s+-R\b/i, 'recursive permission change'],
  [/:\(\)\s*\{/, 'fork bomb'],
  [/\bosascript\b|\blaunchctl\b|\bkillall\b/i, 'system control command'],
];

/** Throws if `text` looks like a dangerous command. */
export function assertSafeText(text: string): void {
  for (const [pattern, label] of DANGEROUS_TEXT) {
    if (pattern.test(text)) throw new Error(`Blocked typing: the text looks like a dangerous command (${label}).`);
  }
}

/** Finder shortcuts that delete files permanently (skipping the Trash). */
export function assertSafeKey(key: string, modifiers: string[]): void {
  const mods = new Set(modifiers);
  const isDelete = key === 'delete' || key === 'fwd-delete';
  if (isDelete && mods.has('cmd') && (mods.has('shift') || mods.has('alt'))) {
    throw new Error('Blocked key: cmd+shift+delete / cmd+option+delete empty the Trash or delete files permanently.');
  }
}

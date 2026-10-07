import { frontmostApp } from '../native/helper';

const BLOCKED_BUNDLE_IDS = new Set([
  'com.apple.Terminal', 'com.googlecode.iterm2', 'com.mitchellh.ghostty', 'net.kovidgoyal.kitty',
  'org.alacritty', 'com.github.wez.wezterm', 'co.zeit.hyper', 'com.raphaelamorim.rio',
  'com.apple.ScriptEditor2', 'com.apple.Automator', 'com.apple.shortcuts',
  'com.microsoft.VSCode', 'com.todesktop.230313mzl4w4u92', 'com.exafunction.windsurf',
  'dev.zed.Zed', 'com.apple.dt.Xcode', 'com.anthropic.claudefordesktop', 'com.openai.chat',
  'com.apple.systempreferences', 'com.apple.keychainaccess', 'com.1password.1password',
  'com.apple.ActivityMonitor',
]);
const BLOCKED_BUNDLE_PREFIXES = ['dev.warp.', 'com.jetbrains.'];

export async function checkIsInputAllowed(what: string): Promise<void> {
  let front: { name: string; bundleId: string };
  try {
    // get the frontmost app
    front = await frontmostApp();
  } catch {
    throw new Error(`Blocked ${what}: could not check which app is in front (is bin/ax-helper built?).`);
  }

  // check if that app is in blocekd list
  const blocked = BLOCKED_BUNDLE_IDS.has(front.bundleId)
    || BLOCKED_BUNDLE_PREFIXES.some((prefix) => front.bundleId.startsWith(prefix));
  
  // if yes then throw an error
  if (!front.bundleId || blocked) {
    throw new Error(
      `Blocked ${what}: "${front.name || 'unknown app'}" is in front, and input to terminals, script runners, ` +
      'code editors, AI apps and security settings is not allowed. Switch to the app you need with open_app first.',
    );
  }
}

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

export function checkIsTextSafe(text: string): void {
  // check if text has any dangerous text
  for (const [pattern, label] of DANGEROUS_TEXT) {
    if (pattern.test(text)) throw new Error(`Blocked typing: the text looks like a dangerous command (${label}).`);
  }
}

export function assertSafeKey(key: string, modifiers: string[]): void {
  // check if the buttons typed are delete commands
  const mods = new Set(modifiers);
  if ((key === 'delete' || key === 'fwd-delete') && mods.has('cmd') && (mods.has('shift') || mods.has('alt'))) {
    throw new Error('Blocked key: cmd+shift+delete / cmd+option+delete empty the Trash or delete files permanently.');
  }
}

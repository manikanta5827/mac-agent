import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { assertInputAllowed, assertSafeKey, assertSafeText } from './guard';

const LOG_DIR = path.join(import.meta.dir, '..', 'logs');
export const SHOT_DIR = path.join(LOG_DIR, 'shots');
const AGENT_LOG = path.join(LOG_DIR, 'agent.jsonl');
const CONVERSATION_LOG = path.join(LOG_DIR, 'conversations', `${new Date().toISOString().slice(0, 19).replaceAll(':', '-')}.jsonl`);

await mkdir(SHOT_DIR, { recursive: true });
await mkdir(path.dirname(CONVERSATION_LOG), { recursive: true });

export async function log(entry: Record<string, unknown>): Promise<void> {
  await appendFile(AGENT_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

export async function logConversation(entry: Record<string, unknown>): Promise<void> {
  await appendFile(CONVERSATION_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
}

async function run(cmd: string[]): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} exited with code ${code}: ${stderr.trim()}`);
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export type ScreenInfo = {
  pointsWidth: number;
  pointsHeight: number;
  pixelsWidth: number;
  pixelsHeight: number;
  scale: number;
};

function parseSize(value: string | undefined): [number, number] | null {
  const m = value?.match(/(\d+)\s*x\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

let cachedScreen: ScreenInfo | null = null;

export async function getScreenInfo(): Promise<ScreenInfo> {
  if (cachedScreen) return cachedScreen;
  const { stdout } = await run(['system_profiler', 'SPDisplaysDataType', '-json']);
  const gpus: any[] = JSON.parse(stdout).SPDisplaysDataType ?? [];
  const displays: any[] = gpus.flatMap((gpu) => gpu.spdisplays_ndrvs ?? []);
  const main = displays.find((d) => d.spdisplays_main === 'spdisplays_yes') ?? displays[0];
  const points = parseSize(main?._spdisplays_resolution);
  const pixels = parseSize(main?._spdisplays_pixels);
  if (!points || !pixels) throw new Error('Could not read display size from system_profiler');
  cachedScreen = {
    pointsWidth: points[0],
    pointsHeight: points[1],
    pixelsWidth: pixels[0],
    pixelsHeight: pixels[1],
    scale: pixels[0] / points[0],
  };
  return cachedScreen;
}

export async function ensureOnScreen(x: number, y: number): Promise<void> {
  const s = await getScreenInfo();
  if (x < 0 || y < 0 || x >= s.pointsWidth || y >= s.pointsHeight) {
    throw new Error(`Point (${x}, ${y}) is outside the screen (0..${s.pointsWidth - 1}, 0..${s.pointsHeight - 1})`);
  }
}

async function cliclick(commands: string[]): Promise<void> {
  const { stderr } = await run(['cliclick', ...commands]);
  if (stderr.includes('Accessibility privileges not enabled')) {
    throw new Error('Accessibility permission missing for the app running this agent (System Settings → Privacy & Security → Accessibility)');
  }
}

export type ClickKind = 'left' | 'double' | 'right' | 'triple';
const CLICK_COMMAND: Record<ClickKind, string> = { left: 'c', double: 'dc', right: 'rc', triple: 'tc' };

export async function click(kind: ClickKind, x: number, y: number): Promise<void> {
  await assertInputAllowed('click');
  await cliclick([`m:${x},${y}`, 'w:100', `${CLICK_COMMAND[kind]}:${x},${y}`]);
}

export async function moveMouse(x: number, y: number): Promise<void> {
  await cliclick([`m:${x},${y}`]);
}

export async function typeText(text: string): Promise<void> {
  assertSafeText(text);
  await assertInputAllowed('typing');
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (i > 0) await pressKey('return');
    if (line) await cliclick([`t:${line}`]);
  }
}

const KEY_CODES = {
  'return': 36, 'enter': 76, 'tab': 48, 'space': 49, 'esc': 53, 'escape': 53, 'delete': 51, 'fwd-delete': 117,
  'arrow-up': 126, 'arrow-down': 125, 'arrow-left': 123, 'arrow-right': 124,
  'home': 115, 'end': 119, 'page-up': 116, 'page-down': 121,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97,
  'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
} as const;
export const NAMED_KEYS = Object.keys(KEY_CODES) as (keyof typeof KEY_CODES)[];

const MODIFIER_NAMES = {
  cmd: { cliclick: 'cmd', applescript: 'command down' },
  shift: { cliclick: 'shift', applescript: 'shift down' },
  alt: { cliclick: 'alt', applescript: 'option down' },
  ctrl: { cliclick: 'ctrl', applescript: 'control down' },
} as const;
export const MODIFIERS = Object.keys(MODIFIER_NAMES) as (keyof typeof MODIFIER_NAMES)[];

export async function pressKey(key: string, modifiers: (keyof typeof MODIFIER_NAMES)[] = []): Promise<void> {
  assertSafeKey(key, modifiers);
  await assertInputAllowed('key press');
  if (key in KEY_CODES) {
    const using = modifiers.length ? ` using {${modifiers.map((m) => MODIFIER_NAMES[m].applescript).join(', ')}}` : '';
    await run(['osascript', '-e', `tell application "System Events" to key code ${KEY_CODES[key as keyof typeof KEY_CODES]}${using}`]);
    return;
  }
  if ([...key].length !== 1) throw new Error(`Unknown key "${key}". Use a single character or one of: ${NAMED_KEYS.join(', ')}`);

  if (modifiers.length === 0) return cliclick([`t:${key}`]);
  const mods = modifiers.map((m) => MODIFIER_NAMES[m].cliclick).join(',');
  await cliclick([`kd:${mods}`, `t:${key}`, `ku:${mods}`]);
}

export type Shot = { path: string; width: number; height: number };

let shotCounter = 0;

export async function shrinkToWidth(file: string, maxWidth: number): Promise<{ width: number; height: number }> {
  const size = await imageSize(file);
  if (size.width > maxWidth) await run(['sips', '--resampleWidth', String(maxWidth), file]);
  return imageSize(file);
}

async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return { width, height };
}

export async function capture(
  region?: { x: number; y: number; width: number; height: number },
  resizeTo?: { width: number; height: number },
): Promise<Shot> {
  shotCounter += 1;
  const name = `${Date.now()}-${shotCounter}${region ? '-zoom' : ''}.jpg`;
  const file = path.join(SHOT_DIR, name);
  const args = ['screencapture', '-x', '-t', 'jpg'];
  if (region) args.push(`-R${region.x},${region.y},${region.width},${region.height}`);
  args.push(file);
  await run(args);

  if (!(await Bun.file(file).exists())) {
    throw new Error('Screenshot was not created. Check Screen Recording permission for the app running this agent.');
  }
  if (resizeTo) await run(['sips', '-z', String(resizeTo.height), String(resizeTo.width), file]);
  return { path: file, ...(await imageSize(file)) };
}

export const ALLOWED_APPS = ['Google Chrome', 'TextEdit', 'Finder', 'Calculator', 'WhatsApp', 'Docker Desktop'] as const;

export async function openApp(app: string): Promise<void> {
  if (!(ALLOWED_APPS as readonly string[]).includes(app)) {
    throw new Error(`App "${app}" is not allowed. Allowed: ${ALLOWED_APPS.join(', ')}`);
  }
  await run(['open', '-a', app]);
}

// The executor: turns tool calls into real macOS commands (cliclick, screencapture, open).
// Every command is spawned with an argument array, never a shell string,
// so text written by the model can't be run as a shell command.
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

const LOG_DIR = path.join(import.meta.dir, 'logs');
export const SHOT_DIR = path.join(LOG_DIR, 'shots');
const AGENT_LOG = path.join(LOG_DIR, 'agent.jsonl');

await mkdir(SHOT_DIR, { recursive: true });

/** One JSON line per action in logs/agent.jsonl. Watch it with: tail -f logs/agent.jsonl */
export async function log(entry: Record<string, unknown>): Promise<void> {
  await appendFile(AGENT_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
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

// ---------- screen info ----------

export type ScreenInfo = {
  pointsWidth: number;  // what cliclick uses (e.g. 1440)
  pointsHeight: number; // (e.g. 900)
  pixelsWidth: number;  // framebuffer / screenshot size (e.g. 2880)
  pixelsHeight: number; // (e.g. 1800)
  scale: number;        // pixels per point (2 on Retina)
};

function parseSize(value: string | undefined): [number, number] | null {
  const m = value?.match(/(\d+)\s*x\s*(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

let cachedScreen: ScreenInfo | null = null;

/** Reads the main display's point and pixel size from system_profiler (no permission needed). */
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

/** Throws if a point is outside the screen, so the model gets an error instead of a silent miss. */
export async function ensureOnScreen(x: number, y: number): Promise<void> {
  const s = await getScreenInfo();
  if (x < 0 || y < 0 || x >= s.pointsWidth || y >= s.pointsHeight) {
    throw new Error(`Point (${x}, ${y}) is outside the screen (0..${s.pointsWidth - 1}, 0..${s.pointsHeight - 1})`);
  }
}

// ---------- mouse & keyboard (cliclick) ----------

async function cliclick(commands: string[]): Promise<void> {
  const { stderr } = await run(['cliclick', ...commands]);
  // cliclick exits 0 even without permission and only prints a warning. Turn that into a real error.
  if (stderr.includes('Accessibility privileges not enabled')) {
    throw new Error('Accessibility permission missing for the app running this agent (System Settings → Privacy & Security → Accessibility)');
  }
}

export type ClickKind = 'left' | 'double' | 'right' | 'triple';
const CLICK_COMMAND: Record<ClickKind, string> = { left: 'c', double: 'dc', right: 'rc', triple: 'tc' };

/** Move first, wait for the move to land, then click (the video's "move, wait, click" rule). */
export async function click(kind: ClickKind, x: number, y: number): Promise<void> {
  await cliclick([`m:${x},${y}`, 'w:100', `${CLICK_COMMAND[kind]}:${x},${y}`]);
}

export async function moveMouse(x: number, y: number): Promise<void> {
  await cliclick([`m:${x},${y}`]);
}

export async function typeText(text: string): Promise<void> {
  await cliclick([`t:${text}`]);
}

// Named keys cliclick's kp: command accepts (from `cliclick -h`).
export const NAMED_KEYS = [
  'return', 'enter', 'tab', 'space', 'esc', 'delete', 'fwd-delete',
  'arrow-up', 'arrow-down', 'arrow-left', 'arrow-right',
  'home', 'end', 'page-up', 'page-down',
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12',
] as const;
export const MODIFIERS = ['cmd', 'shift', 'alt', 'ctrl', 'fn'] as const;

/** A named key (e.g. "return") or a single character (e.g. "l"), optionally with modifiers held down. */
export async function pressKey(key: string, modifiers: string[] = []): Promise<void> {
  let press: string;
  if ((NAMED_KEYS as readonly string[]).includes(key)) press = `kp:${key}`;
  else if ([...key].length === 1) press = `t:${key}`;
  else throw new Error(`Unknown key "${key}". Use a single character or one of: ${NAMED_KEYS.join(', ')}`);

  if (modifiers.length === 0) return cliclick([press]);
  const mods = modifiers.join(',');
  await cliclick([`kd:${mods}`, press, `ku:${mods}`]);
}

// ---------- screenshots (screencapture) ----------

export type Shot = { path: string; width: number; height: number };

let shotCounter = 0;

async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
  const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
  return { width, height };
}

/**
 * Full-screen capture, or only a region when `region` (in points) is given.
 * JPEG keeps each image ~10x smaller than PNG, which matters because every
 * screenshot is re-sent to the model on every later step.
 */
export async function capture(region?: { x: number; y: number; width: number; height: number }): Promise<Shot> {
  shotCounter += 1;
  const name = `${Date.now()}-${shotCounter}${region ? '-zoom' : ''}.jpg`;
  const file = path.join(SHOT_DIR, name);
  const args = ['screencapture', '-x', '-t', 'jpg'];
  if (region) args.push(`-R${region.x},${region.y},${region.width},${region.height}`);
  args.push(file);
  await run(args);

  // Without Screen Recording permission screencapture can fail silently and write nothing.
  if (!(await Bun.file(file).exists())) {
    throw new Error('Screenshot was not created. Check Screen Recording permission for the app running this agent.');
  }
  return { path: file, ...(await imageSize(file)) };
}

// ---------- apps ----------

/** Apps the agent may launch. Anything else has to be opened through the GUI (e.g. Spotlight). */
export const ALLOWED_APPS = ['Google Chrome', 'Safari', 'TextEdit', 'Finder', 'Notes', 'Calculator'] as const;

export async function openApp(app: string, url?: string): Promise<void> {
  if (!(ALLOWED_APPS as readonly string[]).includes(app)) {
    throw new Error(`App "${app}" is not allowed. Allowed: ${ALLOWED_APPS.join(', ')}`);
  }
  if (url !== undefined && !/^https:\/\//.test(url)) throw new Error('Only https:// URLs are allowed');
  await run(url ? ['open', '-a', app, url] : ['open', '-a', app]);
}

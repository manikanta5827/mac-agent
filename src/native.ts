// Executor for native Mac apps: runs bin/ax-helper (native/ax-helper.swift), which reads and operates
// app UIs through the macOS Accessibility API. Same idea as agent-browser for Chrome: the model gets a
// text tree with refs (a1, a2, ...) and acts on a ref instead of guessing pixels.
import path from 'node:path';
import { capture,openApp, type Shot } from './computer';
import { IMAGE_HEIGHT, IMAGE_WIDTH, mapPointToScreenshot } from './mapper';

const HELPER = path.join(import.meta.dir, '..', 'bin', 'ax-helper');

type AxNode = {
  path: string;
  depth: number;
  role: string;
  subrole?: string;
  name?: string;
  value?: string;
  x?: number; y?: number; w?: number; h?: number;
  actions: string[];
  enabled?: boolean;
  focused?: boolean;
};
type AxSnapshot = { app: string; pid: number; nodes: AxNode[]; truncated: boolean };
type AxResult = { ok: boolean; role?: string; name?: string; error?: string };

/** A rectangle in screenshot pixels (the 1229x768 image the model sees). */
type Rect = { x: number; y: number; w: number; h: number };

/** What a ref from the latest snapshot points to. `box` is where it is in the screenshot. */
type RefTarget = { app: string; path: string; role: string; name?: string; box?: Rect };

// Refs are only valid for the latest snapshot (like browser refs).
let latestRefs = new Map<string, RefTarget>();

async function runHelper(args: string[], stdin?: string): Promise<unknown> {
  if (!(await Bun.file(HELPER).exists())) {
    throw new Error('bin/ax-helper is missing. Build it with: swiftc -O native/ax-helper.swift -o bin/ax-helper');
  }
  const proc = Bun.spawn([HELPER, ...args], {
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let parsed: { error?: string } & Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ax-helper ${args[0]} failed: ${(stderr || stdout).trim().slice(0, 300)}`);
  }
  if (proc.exitCode !== 0 || parsed.error) throw new Error(parsed.error ?? `ax-helper ${args[0]} failed`);
  return parsed;
}

// Elements the model can act on: anything with a press-like action, or an input control.
const ACTION_NAMES = new Set(['AXPress', 'AXConfirm', 'AXPick', 'AXIncrement', 'AXDecrement', 'AXOpen']);
const INPUT_ROLES = new Set([
  'AXTextField', 'AXTextArea', 'AXComboBox', 'AXCheckBox', 'AXRadioButton', 'AXPopUpButton',
  'AXSlider', 'AXMenuButton', 'AXMenuItem', 'AXLink', 'AXButton', 'AXDisclosureTriangle',
]);

export function isActionable(node: AxNode): boolean {
  return node.enabled !== false && (INPUT_ROLES.has(node.role) || node.actions.some((a) => ACTION_NAMES.has(a)));
}

// The traffic-light window buttons have no title; name them so the model never presses a mystery button.
const SUBROLE_NAMES: Record<string, string> = {
  AXCloseButton: 'close window',
  AXMinimizeButton: 'minimize window',
  AXZoomButton: 'zoom window',
  AXFullScreenButton: 'full screen',
};

/** Element frame (screen points) → rectangle in screenshot pixels, or undefined if it has no size. */
function toScreenshotRect(node: AxNode): Rect | undefined {
  if (node.x === undefined || node.y === undefined || !node.w || !node.h) return undefined;
  const topLeft = mapPointToScreenshot(node.x, node.y);
  const bottomRight = mapPointToScreenshot(node.x + node.w, node.y + node.h);
  return { x: topLeft.x, y: topLeft.y, w: bottomRight.x - topLeft.x, h: bottomRight.y - topLeft.y };
}

/** "AXTextArea" → "textArea" */
function shortRole(role: string): string {
  const bare = role.replace(/^AX/, '');
  return bare.charAt(0).toLowerCase() + bare.slice(1);
}

/**
 * Turns the helper's node list into a compact text tree for the model, and remembers what each ref means.
 * Lines without a ref, name or value (pure layout containers) are left out; their children keep their indent.
 */
export function formatSnapshot(snapshot: AxSnapshot): { text: string; refs: Map<string, RefTarget> } {
  const refs = new Map<string, RefTarget>();
  const lines: string[] = [];
  for (const node of snapshot.nodes) {
    const actionable = isActionable(node);
    const name = (node.subrole && SUBROLE_NAMES[node.subrole]) || node.name;
    if (!actionable && !name && !node.value) continue;
    let line = `${'  '.repeat(node.depth)}- ${shortRole(node.role)}`;
    line += name ? ` "${name}"` : actionable && !node.value ? ' (no name)' : '';
    if (node.value && node.value !== node.name) line += ` value="${node.value}"`;
    if (node.focused) line += ' (focused)';
    if (node.enabled === false) line += ' (disabled)';
    if (actionable) {
      const ref = `a${refs.size + 1}`;
      const box = toScreenshotRect(node);
      refs.set(ref, { app: snapshot.app, path: node.path, role: node.role, name, box });
      line += ` [ref=${ref}]`;
      // Centre in screenshot pixels, so the model can relate it to a screenshot (and click there as a fallback).
      if (box) line += ` at ${Math.round(box.x + box.w / 2)},${Math.round(box.y + box.h / 2)}`;
    }
    lines.push(line);
  }
  const header = `app "${snapshot.app}"${snapshot.truncated ? ' (very large window: only the first part was read)' : ''}`;
  return { text: [header, ...lines].join('\n'), refs };
}

/** Reads the app's UI. An app opened a moment ago (open_app) may still be starting: waits up to ~10 s for it. */
async function readApp(app: string): Promise<AxSnapshot> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await runHelper(['snapshot', app])) as AxSnapshot;
    } catch (err) {
      if (attempt >= 10 || !String(err).includes('App is not running')) throw err;
      await Bun.sleep(1000);
    }
  }
}

/** Reads the app's windows and returns the text tree. Replaces the previous refs. */
export async function appSnapshot(app: string): Promise<string> {
  const snapshot = await readApp(app);
  if (snapshot.nodes.length === 0) return `app "${app}" has no open windows (or does not expose them).`;
  const { text, refs } = formatSnapshot(snapshot);
  latestRefs = refs;
  return text;
}

/**
 * Brings the app to the front and waits until it really is. `open -a` is used because macOS (14+) ignores
 * "activate" requests from background programs; `open -a` also switches to the desktop (Space) the app is on.
 * macOS only reports an app's windows on the current desktop, so this matters for reading the layout too.
 */
export async function bringToFront(app: string): Promise<void> {
  await openApp(app);
  for (let i = 0; i < 15; i++) {
    const front = (await runHelper(['frontmost'])) as AxResult;
    if (front.name?.toLowerCase() === app.toLowerCase()) {
      await Bun.sleep(300); // let the window finish appearing / the desktop switch finish
      return;
    }
    await Bun.sleep(200);
  }
  throw new Error(`Could not bring ${app} to the front (another app kept focus). Try again, or switch to it with open_app.`);
}

const MAX_BOXES = 80;

/**
 * Chooses which refs get a box on the screenshot: elements with a size whose centre is inside the
 * screenshot AND inside their own window (elements scrolled out of view still report a position).
 */
export function visibleBoxes(snapshot: AxSnapshot, refs: Map<string, RefTarget>): { ref: string; target: RefTarget; box: Rect }[] {
  const windowRects = new Map<string, Rect>();
  for (const node of snapshot.nodes) {
    const rect = node.depth === 0 ? toScreenshotRect(node) : undefined;
    if (rect) windowRects.set(node.path, rect);
  }
  const inside = (px: number, py: number, r: Rect) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  const screen: Rect = { x: 0, y: 0, w: IMAGE_WIDTH, h: IMAGE_HEIGHT };
  const chosen: { ref: string; target: RefTarget; box: Rect }[] = [];
  for (const [ref, target] of refs) {
    const box = target.box;
    if (!box || box.w < 2 || box.h < 2) continue;
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const window = windowRects.get(target.path.split('.')[0]!);
    if (!inside(cx, cy, screen) || (window && !inside(cx, cy, window))) continue;
    chosen.push({ ref, target, box });
    if (chosen.length >= MAX_BOXES) break;
  }
  return chosen;
}

/**
 * Screenshot of an app with a numbered box around every element you can act on.
 * Label N = ref aN. Also returns the list with each element's position and size in screenshot pixels.
 */
export async function appScreenshot(app: string): Promise<Shot & { note: string }> {
  await bringToFront(app); // a screenshot only shows what is on screen
  const snapshot = await readApp(app);
  const { refs } = formatSnapshot(snapshot);
  latestRefs = refs; // the numbers in the picture are the current refs
  const shot = await capture(undefined, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT });

  const boxes = visibleBoxes(snapshot, refs);
  const annotatedPath = shot.path.replace(/\.jpg$/, '-boxes.jpg');
  await runHelper(
    ['annotate', shot.path, annotatedPath],
    JSON.stringify(boxes.map(({ ref, box }) => ({ label: ref.slice(1), ...box }))),
  );
  const legend = boxes.map(({ ref, target, box }) =>
    `[${ref.slice(1)}] ${shortRole(target.role)}${target.name ? ` "${target.name}"` : ''} ` +
    `at ${Math.round(box.x + box.w / 2)},${Math.round(box.y + box.h / 2)} size ${box.w}×${box.h}`);
  const note =
    `Screenshot of ${app} with numbered boxes. Box [N] = ref aN (use app_press aN / app_type aN). ` +
    `Positions are box centres in screenshot pixels (${shot.width}x${shot.height}).\n${legend.join('\n')}`;
  return { ...shot, path: annotatedPath, note };
}

function target(ref: string): RefTarget {
  const key = ref.trim().replace(/^@/, '');
  const found = latestRefs.get(key);
  if (!found) throw new Error(`Unknown ref "${ref}". Use a ref (like a12) from the latest app_snapshot.`);
  return found;
}

/** Presses a button, menu item, checkbox, ... by ref. */
export async function appPress(ref: string): Promise<AxResult> {
  const t = target(ref);
  return (await runHelper(['press', t.app, t.path, t.role])) as AxResult;
}

/** Brings the app to the front and puts keyboard focus on the element (type with cliclick afterwards). */
export async function appFocus(ref: string): Promise<AxResult> {
  const t = target(ref);
  return (await runHelper(['focus', t.app, t.path, t.role])) as AxResult;
}

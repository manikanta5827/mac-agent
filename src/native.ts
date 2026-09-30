// Executor for native Mac apps: runs bin/ax-helper (native/ax-helper.swift), which reads and operates
// app UIs through the macOS Accessibility API. Same idea as agent-browser for Chrome: the model gets a
// text tree with refs (a1, a2, ...) and acts on a ref instead of guessing pixels.
import path from 'node:path';
import { mapPointToScreenshot } from './mapper';

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

/** What a ref from the latest snapshot points to. */
type RefTarget = { app: string; path: string; role: string; name?: string };

// Refs are only valid for the latest snapshot (like browser refs).
let latestRefs = new Map<string, RefTarget>();

async function runHelper(args: string[]): Promise<unknown> {
  if (!(await Bun.file(HELPER).exists())) {
    throw new Error('bin/ax-helper is missing. Build it with: swiftc -O native/ax-helper.swift -o bin/ax-helper');
  }
  const proc = Bun.spawn([HELPER, ...args], { stdout: 'pipe', stderr: 'pipe', timeout: 30_000 });
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
      refs.set(ref, { app: snapshot.app, path: node.path, role: node.role, name });
      line += ` [ref=${ref}]`;
      // Centre in screenshot pixels, so the model can relate it to a screenshot (and click there as a fallback).
      if (node.x !== undefined && node.y !== undefined && node.w && node.h) {
        const centre = mapPointToScreenshot(node.x + node.w / 2, node.y + node.h / 2);
        line += ` at ${centre.x},${centre.y}`;
      }
    }
    lines.push(line);
  }
  const header = `app "${snapshot.app}"${snapshot.truncated ? ' (very large window: only the first part was read)' : ''}`;
  return { text: [header, ...lines].join('\n'), refs };
}

/** Reads the app's windows and returns the text tree. Replaces the previous refs. */
export async function appSnapshot(app: string): Promise<string> {
  // An app opened a moment ago (open_app) may still be starting: wait up to ~10 s for it.
  let snapshot: AxSnapshot | undefined;
  for (let attempt = 1; !snapshot; attempt++) {
    try {
      snapshot = (await runHelper(['snapshot', app])) as AxSnapshot;
    } catch (err) {
      if (attempt >= 10 || !String(err).includes('App is not running')) throw err;
      await Bun.sleep(1000);
    }
  }
  if (snapshot.nodes.length === 0) return `app "${app}" has no open windows (or does not expose them).`;
  const { text, refs } = formatSnapshot(snapshot);
  latestRefs = refs;
  return text;
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

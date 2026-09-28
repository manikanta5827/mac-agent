import { z } from 'zod';
import { tool, type ToolSet } from 'ai';
import {
  ALLOWED_APPS, MODIFIERS, NAMED_KEYS, assertOnScreen, capture, click, getScreenInfo,
  log, moveMouse, openApp, pressKey, typeText, type ClickKind, type Shot,
} from './computer';
import { toScreenPoint } from './mapper';

const point = {
  x: z.number().describe('X coordinate on the screen'),
  y: z.number().describe('Y coordinate on the screen'),
};

/** Sends the image file to the model as the tool result, plus a short text header. */
async function shotToModel(output: Shot & { note: string }) {
  const base64 = Buffer.from(await Bun.file(output.path).arrayBuffer()).toString('base64');
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: output.note },
      { type: 'file' as const, data: { type: 'data' as const, data: base64 }, mediaType: 'image/jpeg' },
    ],
  };
}

/** Shared path for every action that takes a coordinate: map → bounds check → act → log. */
async function atPoint(name: string, raw: { x: number; y: number }, act: (x: number, y: number) => Promise<void>) {
  const mapped = toScreenPoint(raw.x, raw.y);
  try {
    await assertOnScreen(mapped.x, mapped.y);
    await act(mapped.x, mapped.y);
    await log({ tool: name, raw, mapped, ok: true });
    return `ok: ${name} at screen point (${mapped.x}, ${mapped.y})`;
  } catch (err) {
    await log({ tool: name, raw, mapped, ok: false, error: String(err) });
    throw err;
  }
}

function clickTool(kind: ClickKind, description: string) {
  return tool({
    description,
    inputSchema: z.object(point),
    execute: (input) => atPoint(`${kind}_click`, input, (x, y) => click(kind, x, y)),
  });
}

const screenshot = tool({
  description: 'Take a screenshot of the whole screen. Do this first, and after actions to check what changed.',
  inputSchema: z.object({}),
  execute: async () => {
    await Bun.sleep(500); // let the app finish redrawing after the previous action
    const shot = await capture();
    await log({ tool: 'screenshot', path: shot.path, width: shot.width, height: shot.height });
    return { ...shot, note: `Screenshot of the screen, ${shot.width}x${shot.height} pixels.` };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

const zoom = tool({
  description:
    'Look closer at a rectangle of the screen, returned at full detail. Use it for small targets. ' +
    'Coordinates for clicks are still full-screen coordinates, not coordinates inside the zoomed image.',
  inputSchema: z.object({
    ...point,
    width: z.number().positive().describe('Rectangle width'),
    height: z.number().positive().describe('Rectangle height'),
  }),
  execute: async ({ x, y, width, height }) => {
    const topLeft = toScreenPoint(x, y);
    const bottomRight = toScreenPoint(x + width, y + height);
    const region = { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
    await assertOnScreen(region.x, region.y);
    const shot = await capture(region);
    await log({ tool: 'zoom', raw: { x, y, width, height }, region, path: shot.path, width: shot.width, height: shot.height });
    return { ...shot, note: `Zoomed view of region x=${x} y=${y} w=${width} h=${height}, image is ${shot.width}x${shot.height} pixels.` };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

const move_mouse = tool({
  description: 'Move the mouse pointer without clicking.',
  inputSchema: z.object(point),
  execute: (input) => atPoint('move_mouse', input, moveMouse),
});

const type_text = tool({
  description: 'Type text into the focused field of the frontmost app. Click the field first.',
  inputSchema: z.object({ text: z.string().min(1) }),
  execute: async ({ text }) => {
    await typeText(text);
    await log({ tool: 'type_text', text });
    return 'ok';
  },
});

const press_key = tool({
  description:
    'Press one key, optionally with modifiers held. Examples: {key:"return"}, {key:"l", modifiers:["cmd"]} for Cmd+L, ' +
    '{key:"space", modifiers:["cmd"]} for Spotlight, {key:"page-down"} to scroll down.',
  inputSchema: z.object({
    key: z.string().describe(`A single character, or one of: ${NAMED_KEYS.join(', ')}`),
    modifiers: z.array(z.enum(MODIFIERS)).optional(),
  }),
  execute: async ({ key, modifiers }) => {
    await pressKey(key, modifiers);
    await log({ tool: 'press_key', key, modifiers });
    return 'ok';
  },
});

const wait = tool({
  description: 'Wait for the screen to finish loading or changing.',
  inputSchema: z.object({ ms: z.number().int().min(100).max(10_000) }),
  execute: async ({ ms }) => {
    await Bun.sleep(ms);
    return 'ok';
  },
});

const open_app = tool({
  description: `Open (or bring to front) an app, optionally at an https URL. Allowed apps: ${ALLOWED_APPS.join(', ')}.`,
  inputSchema: z.object({
    app: z.enum(ALLOWED_APPS),
    url: z.string().optional().describe('https:// URL to open in the app'),
  }),
  execute: async ({ app, url }) => {
    await openApp(app, url);
    await log({ tool: 'open_app', app, url });
    return `ok: opened ${app}${url ? ` at ${url}` : ''}`;
  },
});

export const tools: ToolSet = {
  screenshot,
  zoom,
  left_click: clickTool('left', 'Left-click at a point on the screen.'),
  double_click: clickTool('double', 'Double-click at a point on the screen.'),
  right_click: clickTool('right', 'Right-click at a point on the screen.'),
  move_mouse,
  type_text,
  press_key,
  wait,
  open_app,
};

// Record the screen geometry once per run, so each log says which sizes were in play.
await log({ event: 'start', screen: await getScreenInfo() });

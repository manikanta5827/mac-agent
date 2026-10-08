import path from 'node:path';
import { z } from 'zod';
import { tool } from 'ai';
import { log, SHOT_DIR } from '../core/log';
import { GLASS_HEIGHT, GLASS_WIDTH, IMAGE_HEIGHT, IMAGE_WIDTH, RETINA_FACTOR, scaleToGlassX, scaleToGlassY, toScreenPoint, zoomMap } from './screen';
import { capture, shotToModel, takeScreenshot } from './shot';
import { ALLOWED_APPS, MODIFIERS, NAMED_KEYS, click as inputClick, moveMouse, openApp, pressKey, typeText } from './input';

// take screenshot and return it
const screenshot = tool({
  description: 'Take a screenshot of the whole screen. Do this first.',
  inputSchema: z.object({}),
  execute: async () => {
    const shot = await takeScreenshot(500);
    const filename = path.basename(shot.path);
    return { ...shot, note: `Screenshot of the screen, ${shot.width}x${shot.height} pixels. File: ${filename}. Use these image pixels for all x/y coordinates.` };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

// tool for clicking on a position
const click_tool = tool({
  description: 'Click at a position on the screen in image pixels.',
  inputSchema: z.object({
    x: z.number().describe('X coordinate in image pixels'),
    y: z.number().describe('Y coordinate in image pixels'),
    file: z.string().optional().describe('Screenshot or zoom image file you are looking at'),
    kind: z.enum(['left', 'double', 'right']).optional().default('left').describe('Click kind: left (default), double, or right'),
  }),
  execute: async ({ x, y, file, kind = 'left' }) => {
    // cnvert the llm co-ordinates to glass to points
    const point = toScreenPoint(x, y, file);

    // click on that point
    await inputClick(kind, point.x, point.y);
    await log({ tool: 'click', raw: { x, y }, point, file, kind });
    return `ok: clicked (${kind}) at (${x}, ${y})`;
  },
});

// tool for moving mouse
const move_mouse = tool({
  description: 'Move mouse cursor to a position on the screen without clicking.',
  inputSchema: z.object({
    x: z.number().describe('X coordinate in image pixels'),
    y: z.number().describe('Y coordinate in image pixels'),
    file: z.string().optional().describe('Screenshot or zoom image file you are looking at'),
  }),
  execute: async ({ x, y, file }) => {
    // cnvert the llm co-ordinates to glass to points
    const point = toScreenPoint(x, y, file);

    // move the mouse
    await moveMouse(point.x, point.y);
    await log({ tool: 'move_mouse', raw: { x, y }, point, file });
    return `ok: moved mouse to (${x}, ${y})`;
  },
});

// tool for typing text
const type_text = tool({
  description: 'Type text into the currently focused field. Click the text field first to focus it.',
  inputSchema: z.object({
    text: z.string().min(1).describe('Text to type'),
  }),
  execute: async ({ text }) => {
    // type the text on the field
    await typeText(text);
    await log({ tool: 'type_text', text });
    return `ok: typed "${text}"`;
  },
});

// tool for pressing keyboard keys
const press_key = tool({
  description:
    `Press a key or keyboard shortcut (e.g. "return", "tab", "esc", or with modifiers like ["cmd"] + "s"). ` +
    `Keys: a single character or one of: ${NAMED_KEYS.join(', ')}.`,
  inputSchema: z.object({
    key: z.string().min(1).describe('Key to press, e.g. "return", "tab", "esc", "c", "v", "s", "space"'),
    modifiers: z.array(z.enum(MODIFIERS)).optional().describe('Modifiers to hold down, e.g. ["cmd"], ["cmd", "shift"]'),
  }),
  execute: async ({ key, modifiers }) => {
    // press the key
    await pressKey(key, modifiers);
    await log({ tool: 'press_key', key, modifiers });
    return `ok: pressed ${modifiers?.length ? modifiers.join('+') + '+' : ''}${key}`;
  },
});

// tool for zoom screenshort
const zoom = tool({
  description:
    'Look closer at a rectangle of the screen, returned at full detail. Use it for small targets. ' +
    'To click something in the zoomed image, call actions with file set to the zoom image file name and (x, y) directly from that image.',
  inputSchema: z.object({
    x: z.number().describe('X of the rectangle\'s TOP-LEFT corner, in screenshot pixels'),
    y: z.number().describe('Y of the rectangle\'s TOP-LEFT corner, in screenshot pixels'),
    width: z.number().positive().describe('Rectangle width, extending to the right of x'),
    height: z.number().positive().describe('Rectangle height, extending down from y'),
  }),
  execute: async ({ x, y, width, height }) => {
    // 1. Convert 720p coordinates to 2880 physical glass pixels
    const rawGlassX = Math.round(x * scaleToGlassX);
    const rawGlassY = Math.round(y * scaleToGlassY);
    const rawGlassW = Math.round(width * scaleToGlassX);
    const rawGlassH = Math.round(height * scaleToGlassY);

    // 2. Validate bounds in 2880 physical glass limits
    if (rawGlassX < 0 || rawGlassY < 0 || rawGlassX >= GLASS_WIDTH || rawGlassY >= GLASS_HEIGHT) {
      throw new Error(`Zoom top-left corner (${x}, ${y}) is outside the screen bounds (0..${IMAGE_WIDTH - 1}, 0..${IMAGE_HEIGHT - 1})`);
    }
    if (rawGlassX + rawGlassW > GLASS_WIDTH || rawGlassY + rawGlassH > GLASS_HEIGHT) {
      throw new Error(
        `Zoom region extends outside the screen. Right edge reaches ${Math.round((rawGlassX + rawGlassW) / scaleToGlassX)} (max ${IMAGE_WIDTH}), bottom edge reaches ${Math.round((rawGlassY + rawGlassH) / scaleToGlassY)} (max ${IMAGE_HEIGHT}). Reduce width/height or adjust (x, y).`
      );
    }

    // 3. Convert physical glass pixels to macOS screen points for screencapture (divide by 2)
    const pointX = Math.round(rawGlassX / RETINA_FACTOR);
    const pointY = Math.round(rawGlassY / RETINA_FACTOR);
    const pointW = Math.max(1, Math.round(rawGlassW / RETINA_FACTOR));
    const pointH = Math.max(1, Math.round(rawGlassH / RETINA_FACTOR));

    const region = { x: pointX, y: pointY, width: pointW, height: pointH };
    if (region.width < 2 || region.height < 2) throw new Error('Zoom region is too small');

    // 4. Capture native region at full Retina detail
    const shot = await capture(region);
    const filename = path.basename(shot.path);

    // 5. Store 2880 physical glass origin in zoomMap
    zoomMap.set(filename, { rawGlassX, rawGlassY });

    await log({ tool: 'zoom', raw: { x, y, width, height }, glass: { rawGlassX, rawGlassY, rawGlassW, rawGlassH }, region, ...shot });
    return {
      ...shot,
      note: `Zoomed view of region x=${x} y=${y} w=${width} h=${height}, shown at ${shot.width}x${shot.height} pixels. File: ${filename}. To click inside this zoom, pass file: "${filename}" and (x, y) directly from this image.`,
    };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

// helper for opening any app
const open_app = tool({
  description:
    `Open (or bring to front) a Mac app. Allowed apps: ${ALLOWED_APPS.join(', ')}. ` +
    'For websites use browser_open instead: the browser_* tools work in their own Chrome window.',
  inputSchema: z.object({ app: z.enum(ALLOWED_APPS) }),
  execute: async ({ app }) => {
    await openApp(app);
    await log({ tool: 'open_app', app });
    return `ok: opened ${app}. If it was not running, it may take a few seconds to start.`;
  },
});

// helper for seeing previous screenshot
const view_screenshot = tool({
  description: 'See an older screenshot or zoom image again, by the file name shown in its tool result (e.g. "1790624481391-14.jpg").',
  inputSchema: z.object({ file: z.string() }),
  execute: async ({ file }) => {
    // llm will pass the screenshot filename, check if its valid
    if (file !== path.basename(file) || !file.endsWith('.jpg')) {
      throw new Error('Give only a .jpg file name from a tool result, no folders');
    }

    // check if screenshot exists or not
    const fullPath = path.join(SHOT_DIR, file);
    if (!(await Bun.file(fullPath).exists())) throw new Error(`No screenshot named ${file}`);

    // send the screenshot buffer
    await log({ tool: 'view_screenshot', file });
    return { path: fullPath, note: 'Older image, NOT the current screen.' };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

export const screenTools = {
  screenshot,
  click: click_tool,
  move_mouse,
  type_text,
  press_key,
  zoom,
  open_app,
  view_screenshot,
};

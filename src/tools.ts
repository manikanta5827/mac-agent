import path from 'node:path';
import { z } from 'zod';
import { tool, type ToolSet } from 'ai';
import {
  ALLOWED_APPS, MODIFIERS, NAMED_KEYS, ensureOnScreen, capture, click, getScreenInfo,
  log, moveMouse, openApp, pressKey, typeText, SHOT_DIR,
} from './computer';
import { mapScreenToPoint } from './mapper';

/**
 * Sends the image file to the model as the tool result, plus a short text header.
 * The header includes the file name, so after compaction removes the image the model
 * can still get it back with view_screenshot.
 */
async function shotToModel(output: { path: string; note: string }) {
  const base64 = Buffer.from(await Bun.file(output.path).arrayBuffer()).toString('base64');
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: `${output.note}\nFile: ${path.basename(output.path)}` },
      { type: 'file' as const, data: { type: 'data' as const, data: base64 }, mediaType: 'image/jpeg' },
    ],
  };
}

async function takeScreenshot(settleMs: number) {
  await Bun.sleep(settleMs); // let the app finish redrawing after the previous action
  const shot = await capture();
  await log({ tool: 'screenshot', path: shot.path, width: shot.width, height: shot.height });
  return shot;
}

const screenshot = tool({
  description: 'Take a screenshot of the whole screen. Do this first.',
  inputSchema: z.object({}),
  execute: async () => {
    const shot = await takeScreenshot(500);
    return { ...shot, note: `Screenshot of the screen, ${shot.width}x${shot.height} pixels.` };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

const CLICK_KINDS = { left_click: 'left', double_click: 'double', right_click: 'right' } as const;

// The only tool that uses mouse and keyboard. The model sends a list of actions,
// we run them one after another in a plain loop, then return one screenshot.
const actions = tool({
  description:
    'Do one or more mouse/keyboard actions in order, then get ONE screenshot of the result. ' +
    'Send several actions when you do not need to look in between, e.g. ' +
    'click a search field → type text → press return. Stops at the first failed action; ' +
    'the rest are reported as skipped.',
  inputSchema: z.object({
    actions: z.array(z.object({
      action: z.enum(['left_click', 'double_click', 'right_click', 'move_mouse', 'type_text', 'press_key', 'wait']),
      x: z.number().optional().describe('For clicks and move_mouse: X on the screen'),
      y: z.number().optional().describe('For clicks and move_mouse: Y on the screen'),
      text: z.string().optional().describe('For type_text. Click the field first.'),
      key: z.string().optional().describe(
        `For press_key: a single character or one of ${NAMED_KEYS.join(', ')}. ` +
        'Examples: {key:"return"}, {key:"l", modifiers:["cmd"]} for Cmd+L, {key:"page-down"} to scroll.',
      ),
      modifiers: z.array(z.enum(MODIFIERS)).optional().describe('For press_key'),
      ms: z.number().optional().describe('For wait, 100 to 10000'),
    })).min(1).max(10),
  }),
  execute: async ({ actions }) => {
    const results: string[] = [];
    let failed = false;

    for (const [i, a] of actions.entries()) {
      const label = `${i + 1}. ${a.action}`;
      if (failed) {
        results.push(`${label}: skipped`);
        continue;
      }
      try {
        switch (a.action) {
          case 'type_text':
            if (!a.text) throw new Error('type_text needs text');
            await typeText(a.text);
            await log({ tool: 'type_text', text: a.text });
            break;

          case 'press_key':
            if (!a.key) throw new Error('press_key needs key');
            await pressKey(a.key, a.modifiers);
            await log({ tool: 'press_key', key: a.key, modifiers: a.modifiers });
            break;

          case 'wait':
            await Bun.sleep(Math.min(Math.max(a.ms ?? 1000, 100), 10_000));
            break;

          case 'left_click':
          case 'double_click':
          case 'right_click':
          case 'move_mouse': {
            // check if co-ordinates exist or not
            if (a.x === undefined || a.y === undefined) {
              throw new Error(`${a.action} needs x and y`);
            }

            // map the co-ordinates
            const mapped = mapScreenToPoint(a.x, a.y);
            await ensureOnScreen(mapped.x, mapped.y);

            // if mouse move do that else click it
            if (a.action === 'move_mouse') {
              await moveMouse(mapped.x, mapped.y);
            }
            else {
              await click(CLICK_KINDS[a.action], mapped.x, mapped.y);
            }

            // log the action
            await log({ tool: a.action, raw: { x: a.x, y: a.y }, mapped });
            break;
          }
        }
        results.push(`${label}: ok`);
        await Bun.sleep(150); // small gap so each action lands before the next one
      } catch (err) {
        failed = true;
        const message = err instanceof Error ? err.message : String(err);
        await log({ tool: a.action, input: a, error: message });
        results.push(`${label}: error (${message})`);
      }
    }

    const shot = await takeScreenshot(700);
    return { ...shot, note: `Results:\n${results.join('\n')}\nScreenshot after the actions, ${shot.width}x${shot.height} pixels.` };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

const zoom = tool({
  description:
    'Look closer at a rectangle of the screen, returned at full detail. Use it for small targets. ' +
    'Coordinates for clicks are still full-screen coordinates, not coordinates inside the zoomed image.',
  inputSchema: z.object({
    x: z.number().describe('X of the rectangle\'s TOP-LEFT corner on the screen'),
    y: z.number().describe('Y of the rectangle\'s TOP-LEFT corner on the screen'),
    width: z.number().positive().describe('Rectangle width, extending to the right of x'),
    height: z.number().positive().describe('Rectangle height, extending down from y'),
  }),
  execute: async ({ x, y, width, height }) => {
    const topLeft = mapScreenToPoint(x, y);
    const bottomRight = mapScreenToPoint(x + width, y + height);
    const region = { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y };
    if (region.width < 1 || region.height < 1) throw new Error('Zoom region is too small');
    // Both corners must be on screen. The bottom-right edge itself is exclusive (like x < 1440),
    // so the last pixel inside the region is (bottomRight - 1).
    await ensureOnScreen(topLeft.x, topLeft.y);
    await ensureOnScreen(bottomRight.x - 1, bottomRight.y - 1);
    const shot = await capture(region);
    await log({ tool: 'zoom', raw: { x, y, width, height }, region, path: shot.path, width: shot.width, height: shot.height });
    return { ...shot, note: `Zoomed view of region x=${x} y=${y} w=${width} h=${height}, image is ${shot.width}x${shot.height} pixels.` };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

const open_app = tool({
  description:
    `Open (or bring to front) an app, optionally at an https URL. Allowed apps: ${ALLOWED_APPS.join(', ')}. ` +
    'Opening a URL in a browser creates a NEW TAB every time. To go to another page in the current tab, ' +
    'press cmd+l, type the URL, and press return instead.',
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

// Shows an older screenshot again. Only file names inside logs/shots are allowed,
// so the model cannot use this to read other files (like .env).
const view_screenshot = tool({
  description: 'See an older screenshot or zoom image again, by the file name shown in its tool result (e.g. "1790624481391-14.jpg").',
  inputSchema: z.object({ file: z.string() }),
  execute: async ({ file }) => {

    // validate the inputs
    if (file !== path.basename(file) || !file.endsWith('.jpg')) {
      throw new Error('Give only a .jpg file name from a tool result, no folders');
    }

    // construct the path
    const fullPath = path.join(SHOT_DIR, file);

    // check if path exists
    if (!(await Bun.file(fullPath).exists())) {
      throw new Error(`No screenshot named ${file}`);
    }

    // log the action
    await log({ tool: 'view_screenshot', file });
    return { path: fullPath, note: 'Older image, NOT the current screen.' };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

export const tools: ToolSet = { screenshot, actions, zoom, open_app, view_screenshot };

// Record the screen geometry once per run, so each log says which sizes were in play.
await log({ event: 'start', screen: await getScreenInfo() });

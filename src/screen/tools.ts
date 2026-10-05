import path from 'node:path';
import { z } from 'zod';
import { tool } from 'ai';
import { log, SHOT_DIR } from '../core/log';
import { IMAGE_HEIGHT, IMAGE_WIDTH, toScreenPoint } from './screen';
import { capture, shotToModel, takeScreenshot } from './shot';
import { ALLOWED_APPS, MODIFIERS, NAMED_KEYS, click, moveMouse, openApp, pressKey, typeText } from './input';

const screenshot = tool({
  description: 'Take a screenshot of the whole screen. Do this first.',
  inputSchema: z.object({}),
  execute: async () => {
    const shot = await takeScreenshot(500);
    return { ...shot, note: `Screenshot of the screen, ${shot.width}x${shot.height} pixels. Use these image pixels for all x/y coordinates.` };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

const CLICK_KINDS = { left_click: 'left', double_click: 'double', right_click: 'right' } as const;

const actions = tool({
  description:
    'Do one or more mouse/keyboard actions in order, then get ONE screenshot of the result. ' +
    'Send several actions when you do not need to look in between, e.g. ' +
    'click a search field → type text → press return. Stops at the first failed action; ' +
    'the rest are reported as skipped.',
  inputSchema: z.object({
    actions: z.array(z.object({
      action: z.enum(['left_click', 'double_click', 'right_click', 'move_mouse', 'type_text', 'press_key', 'wait']),
      x: z.number().optional().describe('For clicks and move_mouse: X in screenshot pixels'),
      y: z.number().optional().describe('For clicks and move_mouse: Y in screenshot pixels'),
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
        if (a.action === 'type_text') {
          if (!a.text) throw new Error('type_text needs text');
          await typeText(a.text);
          await log({ tool: 'type_text', text: a.text });
        } else if (a.action === 'press_key') {
          if (!a.key) throw new Error('press_key needs key');
          await pressKey(a.key, a.modifiers);
          await log({ tool: 'press_key', key: a.key, modifiers: a.modifiers });
        } else if (a.action === 'wait') {
          await Bun.sleep(Math.min(Math.max(a.ms ?? 1000, 100), 10_000));
        } else {
          if (a.x === undefined || a.y === undefined) throw new Error(`${a.action} needs x and y`);
          const point = toScreenPoint(a.x, a.y);
          if (a.action === 'move_mouse') await moveMouse(point.x, point.y);
          else await click(CLICK_KINDS[a.action], point.x, point.y);
          await log({ tool: a.action, raw: { x: a.x, y: a.y }, point });
        }
        results.push(`${label}: ok`);
        await Bun.sleep(150);
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
    x: z.number().describe('X of the rectangle\'s TOP-LEFT corner, in screenshot pixels'),
    y: z.number().describe('Y of the rectangle\'s TOP-LEFT corner, in screenshot pixels'),
    width: z.number().positive().describe('Rectangle width, extending to the right of x'),
    height: z.number().positive().describe('Rectangle height, extending down from y'),
  }),
  execute: async ({ x, y, width, height }) => {
    const topLeft = toScreenPoint(x, y);
    const bottomRight = toScreenPoint(Math.min(x + width, IMAGE_WIDTH) - 1, Math.min(y + height, IMAGE_HEIGHT) - 1);
    const region = { ...topLeft, width: bottomRight.x - topLeft.x + 1, height: bottomRight.y - topLeft.y + 1 };
    if (region.width < 2 || region.height < 2) throw new Error('Zoom region is too small');

    const shot = await capture(region);
    await log({ tool: 'zoom', raw: { x, y, width, height }, region, ...shot });
    return { ...shot, note:
        `Zoomed view of screenshot region x=${x} y=${y} w=${width} h=${height}, shown at ${shot.width}x${shot.height} pixels. ` +
        `To click something at zoom pixel (px, py), use screenshot x = ${x} + px × ${(width / shot.width).toFixed(4)}, ` +
        `y = ${y} + py × ${(height / shot.height).toFixed(4)}.`,
    };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

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

const view_screenshot = tool({
  description: 'See an older screenshot or zoom image again, by the file name shown in its tool result (e.g. "1790624481391-14.jpg").',
  inputSchema: z.object({ file: z.string() }),
  execute: async ({ file }) => {
    if (file !== path.basename(file) || !file.endsWith('.jpg')) {
      throw new Error('Give only a .jpg file name from a tool result, no folders');
    }
    const fullPath = path.join(SHOT_DIR, file);
    if (!(await Bun.file(fullPath).exists())) throw new Error(`No screenshot named ${file}`);

    await log({ tool: 'view_screenshot', file });
    return { path: fullPath, note: 'Older image, NOT the current screen.' };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

export const screenTools = { screenshot, actions, zoom, open_app, view_screenshot };

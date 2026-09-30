import path from 'node:path';
import { z } from 'zod';
import { tool, type ToolSet } from 'ai';
import {
  ALLOWED_APPS, MODIFIERS, NAMED_KEYS, ensureOnScreen, capture, click, getScreenInfo,
  log, moveMouse, openApp, pressKey, typeText, shrinkToWidth, SHOT_DIR,
} from './computer';
import { browser, browserSnapshot, safeArg, splitIntoParts, toRef } from './browser';
import { appFocus, appPress, appSnapshot } from './native';
import { IMAGE_HEIGHT, IMAGE_WIDTH, mapScreenToPoint } from './mapper';

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
  const shot = await capture(undefined, { width: IMAGE_WIDTH, height: IMAGE_HEIGHT });
  await log({ tool: 'screenshot', path: shot.path, width: shot.width, height: shot.height });
  return shot;
}

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
    x: z.number().describe('X of the rectangle\'s TOP-LEFT corner, in screenshot pixels'),
    y: z.number().describe('Y of the rectangle\'s TOP-LEFT corner, in screenshot pixels'),
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

// ---------- Chrome (agent-browser): act on elements by ref, no pixels ----------

/** Runs one agent-browser command for a tool (or `run` for custom steps), logs it, and returns its output. */
async function browserTool(tool: string, args: string[], run = () => browser(args)): Promise<string> {
  try {
    const output = await run();
    await log({ tool, args, outputChars: output.length });
    return output || 'ok';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log({ tool, args, error: message });
    throw err;
  }
}

const refInput = z.string().describe('Element ref from the latest browser_snapshot, e.g. "@e12"');

const browser_snapshot = tool({
  description:
    'Read the current Chrome tab as a text tree of elements (with page text). Interactive elements have refs like [ref=e12]. ' +
    'Refs are only valid until the page changes; take a new snapshot after every page change. ' +
    'Long pages come in parts; the first line says "page part 1 of N".',
  inputSchema: z.object({
    part: z.number().int().min(1).optional().describe('Which part of a long page, default 1 (the top)'),
  }),
  execute: ({ part }) => browserTool('browser_snapshot', ['snapshot', String(part ?? 1)], () => browserSnapshot(part)),
});

const browser_wait = tool({
  description:
    'Wait after an action that changes the page. Give text you expect to appear, or part of the URL you expect; ' +
    'with neither, waits until the page has finished loading. Better than guessing a time.',
  inputSchema: z.object({
    text: z.string().min(1).optional().describe('Text that should appear on the page'),
    url_contains: z.string().min(1).optional().describe('Part of the URL to wait for, e.g. "/feed"'),
  }),
  execute: ({ text, url_contains }) => {
    const args = text ? ['wait', '--text', safeArg(text)]
      : url_contains ? ['wait', '--url', `**${safeArg(url_contains)}**`]
      : ['wait', '--load', 'networkidle'];
    return browserTool('browser_wait', args);
  },
});

const browser_open = tool({
  description: 'Open an https URL in the current Chrome tab.',
  inputSchema: z.object({ url: z.string().describe('https:// URL') }),
  execute: async ({ url }) => {
    if (!/^https:\/\//.test(url)) throw new Error('Only https:// URLs are allowed');
    return browserTool('browser_open', ['open', url]);
  },
});

const browser_click = tool({
  description: 'Click an element in Chrome by its ref.',
  inputSchema: z.object({ ref: refInput }),
  execute: ({ ref }) => browserTool('browser_click', ['click', toRef(ref)]),
});

const browser_fill = tool({
  description: 'Clear a text field in Chrome and type text into it, by its ref.',
  inputSchema: z.object({ ref: refInput, text: z.string().min(1) }),
  execute: ({ ref, text }) => browserTool('browser_fill', ['fill', toRef(ref), safeArg(text)]),
});

const browser_press = tool({
  description: 'Press a key in Chrome, e.g. "Enter", "Tab", "Escape", "Control+a".',
  inputSchema: z.object({ key: z.string().min(1) }),
  execute: ({ key }) => browserTool('browser_press', ['press', safeArg(key)]),
});

const browser_scroll = tool({
  description: 'Scroll the Chrome page up or down.',
  inputSchema: z.object({
    direction: z.enum(['up', 'down']),
    pixels: z.number().int().min(100).max(3000).optional().describe('How far, default 800'),
  }),
  execute: ({ direction, pixels }) => browserTool('browser_scroll', ['scroll', direction, String(pixels ?? 800)]),
});

const browser_back = tool({
  description: 'Go back one page in Chrome.',
  inputSchema: z.object({}),
  execute: () => browserTool('browser_back', ['back']),
});

const browser_screenshot = tool({
  description:
    'Look at the Chrome tab. Every interactive element gets a red box with a number [N], which is ref @eN. ' +
    'Only use it when you need to see something visually (icons without names, layout, checking a result); prefer browser_snapshot.',
  inputSchema: z.object({}),
  execute: async () => {
    const file = path.join(SHOT_DIR, `${Date.now()}-browser.jpg`);
    const legend = await browserTool('browser_screenshot', [
      '--screenshot-format', 'jpeg', '--screenshot-quality', '80', 'screenshot', '--annotate', file,
    ]);
    const size = await shrinkToWidth(file, IMAGE_WIDTH); // fewer image tokens; clicks use refs, not pixels
    return { path: file, ...size, note: `Annotated Chrome screenshot. Label [N] = ref @eN.\n${legend}` };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

// ---------- native Mac apps (Accessibility tree via bin/ax-helper): act on elements by ref ----------

// Chrome has its own browser_* tools.
const NATIVE_APPS = ALLOWED_APPS.filter((app) => app !== 'Google Chrome') as [string, ...string[]];

/** Runs one native-app step for a tool, logs it, and returns its text. */
async function nativeTool(tool: string, input: Record<string, unknown>, run: () => Promise<string>): Promise<string> {
  try {
    const output = await run();
    await log({ tool, ...input, outputChars: output.length });
    return output;
  } catch (err) {
    await log({ tool, ...input, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

const app_snapshot = tool({
  description:
    'Read a native Mac app\'s open windows as a text tree of elements (buttons, fields, menus, text). ' +
    'Elements you can act on have refs like [ref=a12] and "at x,y" = their centre in screenshot pixels. ' +
    'Refs are only valid until the window changes; take a new app_snapshot after every change. Long trees come in parts.',
  inputSchema: z.object({
    app: z.enum(NATIVE_APPS),
    part: z.number().int().min(1).optional().describe('Which part of a long tree, default 1'),
  }),
  execute: ({ app, part }) => nativeTool('app_snapshot', { app, part }, async () => {
    const parts = splitIntoParts(await appSnapshot(app), 20_000);
    if (parts.length <= 1) return parts[0] ?? '';
    const index = Math.min(Math.max(part ?? 1, 1), parts.length) - 1;
    const more = index + 1 < parts.length ? ` For the next part, call app_snapshot with part ${index + 2}.` : '';
    return `[part ${index + 1} of ${parts.length}.${more}]\n${parts[index]}`;
  }),
});

const app_press = tool({
  description: 'Press a button, menu item, checkbox, tab or link in a native app, by ref from the latest app_snapshot. No mouse needed.',
  inputSchema: z.object({ ref: z.string().describe('Ref like "a12"') }),
  execute: ({ ref }) => nativeTool('app_press', { ref }, async () => {
    const result = await appPress(ref);
    return `pressed ${result.role ?? ''} "${result.name ?? ''}". Take a new app_snapshot to see the result.`;
  }),
});

const app_type = tool({
  description:
    'Type text into a field of a native app, by ref: brings the app to the front, focuses the field, then types. ' +
    'Typing adds at the cursor; to replace existing text, press cmd+a first with the actions tool.',
  inputSchema: z.object({ ref: z.string().describe('Ref like "a12"'), text: z.string().min(1) }),
  execute: ({ ref, text }) => nativeTool('app_type', { ref, text }, async () => {
    const result = await appFocus(ref);
    await Bun.sleep(300); // let the app come to the front before typing
    await typeText(text);
    return `typed into ${result.role ?? ''} "${result.name ?? ''}". Take a new app_snapshot to check.`;
  }),
});

export const tools: ToolSet = {
  // native Mac apps: structure first (Accessibility tree), pixels as the fallback
  app_snapshot, app_press, app_type,
  // whole-screen tools (pixels) for native Mac apps
  screenshot, actions, zoom, open_app, view_screenshot,
  // Chrome tools (page structure + refs)
  browser_snapshot, browser_open, browser_click, browser_fill, browser_press, browser_scroll, browser_back, browser_wait,
  browser_screenshot,
};

// Record the screen geometry once per run, so each log says which sizes were in play.
await log({ event: 'start', screen: await getScreenInfo() });

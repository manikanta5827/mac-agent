import path from 'node:path';
import { z } from 'zod';
import { tool } from 'ai';
import { logged, SHOT_DIR } from '../core/log';
import { IMAGE_WIDTH } from '../screen/screen';
import { shotToModel, shrinkToWidth } from '../screen/shot';
import { browser, browserSnapshot, safeArg, toRef } from './browser';

const call = (name: string, args: string[], run = () => browser(args)) =>
  logged(name, { args }, async () => (await run()) || 'ok');

const refInput = z.string().describe('Element ref from the latest browser_snapshot, e.g. "@e12"');

const browser_snapshot = tool({
  description:
    'Read the current Chrome tab as a text tree of elements (with page text). Interactive elements have refs like [ref=e12]. ' +
    'Refs are only valid until the page changes; take a new snapshot after every page change. ' +
    'Long pages come in parts; the first line says "part 1 of N".',
  inputSchema: z.object({
    part: z.number().int().min(1).optional().describe('Which part of a long page, default 1 (the top)'),
  }),
  execute: ({ part }) => call('browser_snapshot', ['snapshot', String(part ?? 1)], () => browserSnapshot(part)),
});

const browser_wait = tool({
  description:
    'Wait after an action that changes the page. Give text you expect to appear, or part of the URL you expect; ' +
    'with neither, waits until the page has finished loading. Better than guessing a time.',
  inputSchema: z.object({
    text: z.string().min(1).optional().describe('Text that should appear on the page'),
    url_contains: z.string().min(1).optional().describe('Part of the URL to wait for, e.g. "/feed"'),
  }),
  execute: ({ text, url_contains }) => call('browser_wait',
    text ? ['wait', '--text', safeArg(text)]
      : url_contains ? ['wait', '--url', `**${safeArg(url_contains)}**`]
      : ['wait', '--load', 'networkidle']),
});

const browser_open = tool({
  description: 'Open an https URL in the current Chrome tab.',
  inputSchema: z.object({ url: z.string().describe('https:// URL') }),
  execute: ({ url }) => {
    if (!url.startsWith('https://')) throw new Error('Only https:// URLs are allowed');
    return call('browser_open', ['open', url]);
  },
});

const browser_click = tool({
  description: 'Click an element in Chrome by its ref.',
  inputSchema: z.object({ ref: refInput }),
  execute: ({ ref }) => call('browser_click', ['click', toRef(ref)]),
});

const browser_fill = tool({
  description: 'Clear a text field in Chrome and type text into it, by its ref.',
  inputSchema: z.object({ ref: refInput, text: z.string().min(1) }),
  execute: ({ ref, text }) => call('browser_fill', ['fill', toRef(ref), safeArg(text)]),
});

const browser_press = tool({
  description: 'Press a key in Chrome, e.g. "Enter", "Tab", "Escape", "Control+a".',
  inputSchema: z.object({ key: z.string().min(1) }),
  execute: ({ key }) => call('browser_press', ['press', safeArg(key)]),
});

const browser_scroll = tool({
  description: 'Scroll the Chrome page up or down.',
  inputSchema: z.object({
    direction: z.enum(['up', 'down']),
    pixels: z.number().int().min(100).max(3000).optional().describe('How far, default 800'),
  }),
  execute: ({ direction, pixels }) => call('browser_scroll', ['scroll', direction, String(pixels ?? 800)]),
});

const browser_back = tool({
  description: 'Go back one page in Chrome.',
  inputSchema: z.object({}),
  execute: () => call('browser_back', ['back']),
});

const browser_screenshot = tool({
  description:
    'Look at the Chrome tab. Every interactive element gets a red box with a number [N], which is ref @eN. ' +
    'Only use it when you need to see something visually (icons without names, layout, checking a result); prefer browser_snapshot.',
  inputSchema: z.object({}),
  execute: async () => {
    const file = path.join(SHOT_DIR, `${Date.now()}-browser.jpg`);
    const legend = await call('browser_screenshot', [
      '--screenshot-format', 'jpeg', '--screenshot-quality', '80', 'screenshot', '--annotate', file,
    ]);
    const size = await shrinkToWidth(file, IMAGE_WIDTH);
    return { path: file, ...size, note: `Annotated Chrome screenshot. Label [N] = ref @eN.\n${legend}` };
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

export const browserTools = {
  browser_snapshot, browser_open, browser_click, browser_fill, browser_press,
  browser_scroll, browser_back, browser_wait, browser_screenshot,
};

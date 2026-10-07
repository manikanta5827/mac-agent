import { z } from 'zod';
import { tool } from 'ai';
import { log } from '../core/log';
import { ALLOWED_APPS, typeText } from '../screen/input';
import { shotToModel } from '../screen/shot';
import { appAct, appScreenshot, appSnapshot } from './native';

const NATIVE_APPS = ALLOWED_APPS.filter((app) => app !== 'Google Chrome') as [string, ...string[]];
const refInput = z.string().describe('Ref like "a12" from the latest app_snapshot');

const app_snapshot = tool({
  description:
    'Read a native Mac app\'s open windows as a text tree of elements (buttons, fields, menus, text). ' +
    'Elements you can act on have refs like [ref=a12] and "at x,y" = their centre in screenshot pixels. ' +
    'Refs are only valid until the window changes; take a new app_snapshot after every change. Long trees come in parts.',
  inputSchema: z.object({
    app: z.enum(NATIVE_APPS),
    part: z.number().int().min(1).optional().describe('Which part of a long tree, default 1'),
  }),
  execute: ({ app, part }) => appSnapshot(app, part),
});

const app_screenshot = tool({
  description:
    'Look at a native Mac app: brings it to the front and returns a screenshot with a numbered box around every element ' +
    'you can act on, plus a list of each box\'s centre and size. Box [N] = ref aN (use app_press aN / app_type aN). ' +
    'Use it when app_snapshot is not enough: icons without names, layout, or checking a result visually.',
  inputSchema: z.object({ app: z.enum(NATIVE_APPS) }),
  execute: async ({ app }) => {
    const shot = await appScreenshot(app);
    await log({ tool: 'app_screenshot', app, path: shot.path, boxes: shot.note.split('\n').length - 1 });
    return shot;
  },
  toModelOutput: ({ output }) => shotToModel(output),
});

const app_press = tool({
  description: 'Press a button, menu item, checkbox, tab or link in a native app, by ref from the latest app_snapshot. No mouse needed.',
  inputSchema: z.object({ ref: refInput }),
  execute: async ({ ref }) => {
    const result = await appAct('press', ref);
    return `pressed ${result.role ?? ''} "${result.name ?? ''}". Take a new app_snapshot to see the result.`;
  },
});

const app_type = tool({
  description:
    'Type text into a field of a native app, by ref: brings the app to the front, focuses the field, then types. ' +
    'Typing adds at the cursor; to replace existing text, press cmd+a first with the actions tool.',
  inputSchema: z.object({ ref: refInput, text: z.string().min(1) }),
  execute: async ({ ref, text }) => {
    const result = await appAct('focus', ref);
    await Bun.sleep(300);
    await typeText(text);
    return `typed into ${result.role ?? ''} "${result.name ?? ''}". Take a new app_snapshot to check.`;
  },
});

export const nativeTools = { app_snapshot, app_screenshot, app_press, app_type };

import path from 'node:path';
import { runOk } from '../core/sh';
import { log, SHOT_DIR } from '../core/log';
import { IMAGE_HEIGHT, IMAGE_WIDTH } from './screen';

export type Shot = { path: string; width: number; height: number };
export type ShotOutput = { path: string; note: string };

// get the image width and height
async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const out = await runOk(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  return {
    width: Number(out.match(/pixelWidth:\s*(\d+)/)?.[1]),
    height: Number(out.match(/pixelHeight:\s*(\d+)/)?.[1]),
  };
}

// shrink the image to specific width
export async function shrinkToWidth(file: string, maxWidth: number): Promise<{ width: number; height: number }> {
  // get the image size
  const size = await imageSize(file);

  // check if its crossing the maxwidth a model can understand
  if (size.width <= maxWidth) return size;

  // run the scale down command
  await runOk(['sips', '--resampleWidth', String(maxWidth), file]);

  // return new width and height
  return imageSize(file);
}

export async function capture(region?: { x: number; y: number; width: number; height: number }): Promise<Shot> {
  // construct the file name
  const file = path.join(SHOT_DIR, `${Date.now()}${region ? '-zoom' : ''}.jpg`);

  // construct the args
  const args = ['screencapture', '-x', '-t', 'jpg'];

  // if its zoomed call add co-ordinates to the screenshot command
  if (region) args.push(`-R${region.x},${region.y},${region.width},${region.height}`);

  // run the command
  await runOk([...args, file]);

  // check if screenshot exists in this path
  if (!(await Bun.file(file).exists())) {
    throw new Error('Screenshot was not created. Check Screen Recording permission for the app running this agent.');
  }

  // if its not zoomed call , then scale down the image so agent can click correctly
  if (!region) await runOk(['sips', '-z', String(IMAGE_HEIGHT), String(IMAGE_WIDTH), file]);

  // return the file path and image width and height
  return { path: file, ...(await imageSize(file)) };
}

export async function takeScreenshot(settleMs: number): Promise<Shot> {
  // wait for some time
  await Bun.sleep(settleMs);

  // capture the screen and return the path,width,height
  const shot = await capture();
  await log({ tool: 'screenshot', ...shot });

  // return
  return shot;
}

// convert the data to model format
export async function shotToModel(output: ShotOutput) {
  const base64 = Buffer.from(await Bun.file(output.path).arrayBuffer()).toString('base64');
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text: `${output.note}\nFile: ${path.basename(output.path)}` },
      { type: 'file' as const, data: { type: 'data' as const, data: base64 }, mediaType: 'image/jpeg' },
    ],
  };
}

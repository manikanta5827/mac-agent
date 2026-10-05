import path from 'node:path';
import { runOk } from '../core/sh';
import { log, SHOT_DIR } from '../core/log';
import { IMAGE_HEIGHT, IMAGE_WIDTH } from './screen';

export type Shot = { path: string; width: number; height: number };
export type ShotOutput = { path: string; note: string };

let counter = 0;

async function imageSize(file: string): Promise<{ width: number; height: number }> {
  const out = await runOk(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file]);
  return {
    width: Number(out.match(/pixelWidth:\s*(\d+)/)?.[1]),
    height: Number(out.match(/pixelHeight:\s*(\d+)/)?.[1]),
  };
}

export async function shrinkToWidth(file: string, maxWidth: number): Promise<{ width: number; height: number }> {
  const size = await imageSize(file);
  if (size.width <= maxWidth) return size;
  await runOk(['sips', '--resampleWidth', String(maxWidth), file]);
  return imageSize(file);
}

export async function capture(region?: { x: number; y: number; width: number; height: number }): Promise<Shot> {
  counter += 1;
  const file = path.join(SHOT_DIR, `${Date.now()}-${counter}${region ? '-zoom' : ''}.jpg`);
  const args = ['screencapture', '-x', '-t', 'jpg'];
  if (region) args.push(`-R${region.x},${region.y},${region.width},${region.height}`);
  await runOk([...args, file]);

  if (!(await Bun.file(file).exists())) {
    throw new Error('Screenshot was not created. Check Screen Recording permission for the app running this agent.');
  }
  if (!region) await runOk(['sips', '-z', String(IMAGE_HEIGHT), String(IMAGE_WIDTH), file]);
  return { path: file, ...(await imageSize(file)) };
}

export async function takeScreenshot(settleMs: number): Promise<Shot> {
  await Bun.sleep(settleMs);
  const shot = await capture();
  await log({ tool: 'screenshot', ...shot });
  return shot;
}

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

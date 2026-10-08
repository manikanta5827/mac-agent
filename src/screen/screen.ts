import { runOk } from '../core/sh';

export const IMAGE_HEIGHT = 720;

async function readMainDisplay(): Promise<{
  width: number;
  height: number;
  glassW: number;
  glassH: number;
  retinaFactor: number;
}> {
  // read the displays from the system_profiler
  const json = JSON.parse(await runOk(['system_profiler', 'SPDisplaysDataType', '-json']));
  const displays = json.SPDisplaysDataType?.flatMap((gpu: any) => gpu.spdisplays_ndrvs ?? []) ?? [];

  // get the main display
  const main = displays.find((d: any) => d.spdisplays_main === 'spdisplays_yes') ?? displays[0];

  // get logical points resolution (e.g. "1440 x 900 @ 60.00Hz")
  const [width, height] = main?._spdisplays_resolution?.match(/\d+/g)?.map(Number) ?? [];
  if (!width || !height) throw new Error('Could not read main display resolution');

  // get physical glass pixels (e.g. "2880 x 1800")
  const [glassW, glassH] = main?._spdisplays_pixels?.match(/\d+/g)?.map(Number) ?? [];
  const retinaFactor = Math.round(glassW / width) || 2;

  return { width, height, glassW, glassH, retinaFactor };
}

// get the screen geometry dynamically from macOS
export const SCREEN = await readMainDisplay();
export const IMAGE_WIDTH = Math.round((IMAGE_HEIGHT * SCREEN.width) / SCREEN.height);

// get the screen actual widht, height and glass to point scalling factor
export const RETINA_FACTOR = SCREEN.retinaFactor;
export const GLASS_WIDTH = SCREEN.glassW;
export const GLASS_HEIGHT = SCREEN.glassH;

// get the scaling factor between glass to image
export const scaleToGlassX = GLASS_WIDTH / IMAGE_WIDTH;
export const scaleToGlassY = GLASS_HEIGHT / IMAGE_HEIGHT;

// construct the hashmap for the zoom images used for clicking
export type ZoomCrop = { rawGlassX: number; rawGlassY: number };
export const zoomMap = new Map<string, ZoomCrop>();

// used for converting points to llm co-ordinates
export function toImagePoint(pointX: number, pointY: number): { x: number; y: number } {
  const glassX = pointX * RETINA_FACTOR;
  const glassY = pointY * RETINA_FACTOR;
  return {
    x: Math.round(glassX / scaleToGlassX),
    y: Math.round(glassY / scaleToGlassY),
  };
}

// convert the llm returned co-ordinates to glasspixles to points
export function toScreenPoint(x: number, y: number, file?: string): { x: number; y: number } {
  // get the specific file
  const zoomCrop = file ? zoomMap.get(file) : undefined;

  let glassX: number;
  let glassY: number;

  // check if this is zoom image
  if (zoomCrop) {
    // add the zoomed co-ordinates to the click co-ordinates to get the glass co-ordinates
    glassX = zoomCrop.rawGlassX + x;
    glassY = zoomCrop.rawGlassY + y;
  } else {
    // if normal image , then only scale up to 2880 pixels resolution
    glassX = x * scaleToGlassX;
    glassY = y * scaleToGlassY;
  }

  // convert the glass co-ordinates to points
  const point = {
    x: Math.round(glassX / RETINA_FACTOR),
    y: Math.round(glassY / RETINA_FACTOR),
  };

  // validate them
  if (point.x < 0 || point.y < 0 || point.x >= SCREEN.width || point.y >= SCREEN.height) {
    throw new Error(`Point (${x}, ${y}) is outside the screen (0..${SCREEN.width - 1}, 0..${SCREEN.height - 1})`);
  }

  return point;
}

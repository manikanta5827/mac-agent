// Converts coordinates written by the model into screen points (what cliclick uses).
//
// The model sees every full screenshot resized to IMAGE_WIDTH x IMAGE_HEIGHT and answers in
// those image pixels. Here we scale its answer back to points (1440x900 on this Mac).
//
// Why 768 high: OpenAI shrinks images so the short side is at most 768 px, and other providers
// resize in their own ways. If we send exactly this size ourselves, the model sees the same
// pixels we measure in, so there is no hidden resize for it to guess.
import { getScreenInfo } from './computer';

const screen = await getScreenInfo();

export const IMAGE_HEIGHT = 768;
export const IMAGE_WIDTH = Math.round((IMAGE_HEIGHT * screen.pointsWidth) / screen.pointsHeight); // 1229 for 1440x900

const scaleX = screen.pointsWidth / IMAGE_WIDTH;   // ≈ 1.1717
const scaleY = screen.pointsHeight / IMAGE_HEIGHT; // ≈ 1.1719

/** Screenshot pixel (what the model says) → screen point (where we click). */
export function mapScreenToPoint(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(x * scaleX), y: Math.round(y * scaleY) };
}

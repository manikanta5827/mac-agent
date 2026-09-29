// Converts coordinates written by the model into screen points (what cliclick uses).
//
// Right now it passes them through unchanged. This is the "no mapper" baseline
// for the boxes experiment: compare where the model aimed with where the click
// landed (boxes-app log), work out the formula, then implement it here.
export function mapScreenToPoint(x: number, y: number): { x: number; y: number } {
  return { x: Math.round(x), y: Math.round(y) };
}

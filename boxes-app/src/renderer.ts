// Draws numbered boxes at random places, turns a box green when clicked,
// and logs every click with how far it landed from the nearest box's center.
//
// Units:
//   page point   = position inside this window (what the DOM gives us)
//   screen point = page point + window's top-left corner (what cliclick uses)
//   screenshot px = screen point × devicePixelRatio (what `screencapture` produces)

type Box = { id: number; el: HTMLDivElement; left: number; top: number; width: number; height: number };

const BOX_COUNT = 8;
const BOX_WIDTH = 110;
const BOX_HEIGHT = 60;
const GAP = 30;          // minimum space between boxes
const TOOLBAR_HEIGHT = 56;

const statusEl = document.getElementById('status')!;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;

const boxes: Box[] = [];
let markers: HTMLDivElement[] = [];
let hits = 0;
let misses = 0;

// Frameless window: page (0,0) is the window's top-left corner on screen.
const originX = window.screenX;
const originY = window.screenY;
const scale = window.devicePixelRatio;

function emit(entry: Record<string, unknown> & { text: string }): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }));
}

function center(b: Box) {
  const page = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  const screen = { x: originX + page.x, y: originY + page.y };
  return { page, screen, screenshot: { x: screen.x * scale, y: screen.y * scale } };
}

function overlaps(a: { left: number; top: number }, b: Box): boolean {
  return (
    a.left < b.left + b.width + GAP && a.left + BOX_WIDTH + GAP > b.left &&
    a.top < b.top + b.height + GAP && a.top + BOX_HEIGHT + GAP > b.top
  );
}

function placeBoxes(): void {
  const maxLeft = window.innerWidth - BOX_WIDTH - GAP;
  const maxTop = window.innerHeight - BOX_HEIGHT - GAP;
  for (let id = 1; id <= BOX_COUNT; id++) {
    let pos = { left: 0, top: 0 };
    for (let attempt = 0; attempt < 1000; attempt++) {
      pos = {
        left: Math.round(GAP + Math.random() * (maxLeft - GAP)),
        top: Math.round(TOOLBAR_HEIGHT + GAP + Math.random() * (maxTop - TOOLBAR_HEIGHT - GAP)),
      };
      if (!boxes.some((b) => overlaps(pos, b))) break;
    }
    const el = document.createElement('div');
    el.className = 'box';
    el.textContent = `Box ${id}`;
    Object.assign(el.style, { left: `${pos.left}px`, top: `${pos.top}px`, width: `${BOX_WIDTH}px`, height: `${BOX_HEIGHT}px` });
    document.body.appendChild(el);
    boxes.push({ id, el, ...pos, width: BOX_WIDTH, height: BOX_HEIGHT });
  }
}

function logLayout(): void {
  const rows = boxes.map((b) => {
    const c = center(b);
    return { id: b.id, screenCenter: c.screen, screenshotCenter: c.screenshot };
  });
  const lines = rows.map(
    (r) => `  Box ${r.id}: center screen point (${r.screenCenter.x}, ${r.screenCenter.y})  screenshot px (${r.screenshotCenter.x}, ${r.screenshotCenter.y})`
  );
  emit({
    type: 'layout',
    origin: { x: originX, y: originY },
    scale,
    boxes: rows,
    text: `[layout] window origin (${originX}, ${originY}) points, scale ${scale}\n${lines.join('\n')}`,
  });
}

function updateStatus(): void {
  statusEl.textContent = `Boxes clicked: ${boxes.filter((b) => b.el.classList.contains('hit')).length}/${BOX_COUNT}   hits: ${hits}   misses: ${misses}`;
}

function addMarker(x: number, y: number, hit: boolean): void {
  const m = document.createElement('div');
  m.className = `marker ${hit ? 'hit' : 'miss'}`;
  Object.assign(m.style, { left: `${x}px`, top: `${y}px` });
  document.body.appendChild(m);
  markers.push(m);
}

function onClick(e: MouseEvent): void {
  if (e.target === resetBtn) return;

  const hitBox = boxes.find(
    (b) => e.clientX >= b.left && e.clientX < b.left + b.width && e.clientY >= b.top && e.clientY < b.top + b.height
  );

  // Nearest box by distance to its center; dx/dy = where the click landed minus where it should have.
  let nearest = boxes[0]!;
  let best = Infinity;
  for (const b of boxes) {
    const c = center(b).page;
    const d = Math.hypot(e.clientX - c.x, e.clientY - c.y);
    if (d < best) { best = d; nearest = b; }
  }
  const c = center(nearest);
  const dx = Math.round(e.clientX - c.page.x);
  const dy = Math.round(e.clientY - c.page.y);

  if (hitBox) { hits++; hitBox.el.classList.add('hit'); } else { misses++; }
  addMarker(e.clientX, e.clientY, !!hitBox);
  updateStatus();

  // Screen point where the click landed = window origin + page point (same unit cliclick uses).
  const screen = { x: originX + e.clientX, y: originY + e.clientY };

  emit({
    type: 'click',
    screen,
    page: { x: e.clientX, y: e.clientY },
    hit: hitBox?.id ?? null,
    nearest: nearest.id,
    nearestCenter: c.screen,
    dx,
    dy,
    distance: Math.round(best),
    trusted: e.isTrusted,
    text: hitBox
      ? `[click] HIT  Box ${hitBox.id} at screen (${screen.x}, ${screen.y})  offset from center dx=${dx} dy=${dy}`
      : `[click] MISS at screen (${screen.x}, ${screen.y})  nearest Box ${nearest.id} center (${c.screen.x}, ${c.screen.y})  dx=${dx} dy=${dy} distance=${Math.round(best)}`,
  });
}

function reset(): void {
  for (const b of boxes) b.el.classList.remove('hit');
  for (const m of markers) m.remove();
  markers = [];
  hits = 0;
  misses = 0;
  updateStatus();
  emit({ type: 'reset', text: '[reset] all boxes back to blue' });
}

placeBoxes();
updateStatus();
logLayout();
resetBtn.addEventListener('click', reset);
window.addEventListener('click', onClick);

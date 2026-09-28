// Electron main process: opens one frameless window covering the usable screen,
// and turns log lines from the page into terminal output + logs/clicks.jsonl.
import { app, BrowserWindow, screen } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'clicks.jsonl');

function createWindow(): void {
  mkdirSync(LOG_DIR, { recursive: true });

  // workArea = the screen minus the menu bar and the Dock, in points.
  const area = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    frame: false,       // no title bar, so page (0,0) is exactly the window's top-left corner
    resizable: false,
    movable: false,
    alwaysOnTop: true,  // stay above the terminal so the agent always sees the boxes
    backgroundColor: '#1e1e1e',
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));

  // The page logs one JSON object per event. Print its text and keep the full JSON on disk.
  win.webContents.on('console-message', (details) => {
    let entry: { text?: string };
    try {
      entry = JSON.parse(details.message);
    } catch {
      console.log(details.message);
      return;
    }
    console.log(entry.text ?? details.message);
    appendFileSync(LOG_FILE, details.message + '\n');
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

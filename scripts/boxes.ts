// Try the numbered-boxes screenshot for a native app, outside the agent.
// Usage: bun scripts/boxes.ts "Docker Desktop"      (the app must be running)
import { appScreenshot } from '../src/native';

const app = process.argv[2] ?? 'Finder';
const shot = await appScreenshot(app);
console.log(shot.note);
console.log(`\nImage: ${shot.path}`);
await Bun.spawn(['open', shot.path]).exited; // opens it in Preview

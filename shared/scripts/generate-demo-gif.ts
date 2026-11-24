import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const gifPath = resolve(process.cwd(), 'docs/demo-lab05.gif');
if (existsSync(gifPath)) {
  console.log(`Demo GIF already exists at ${gifPath}`);
} else {
  console.log('Demo GIF path:', gifPath);
}

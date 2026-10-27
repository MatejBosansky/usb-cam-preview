#!/usr/bin/env node
// Renders public/favicon.ico (16, 32 and 48 px) and public/apple-touch-icon.png (180 px) from
// public/icon.svg. Run it after changing the icon; the build does not.
//   node scripts/icons.mjs     needs Node 22+ and Chrome (set CHROME to its path if it is elsewhere)
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_DIR } from './lib/library.mjs';

const CHROME = process.env.CHROME || {
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}[process.platform] || 'google-chrome';
const ICO_SIZES = [16, 32, 48];
// iOS shows a transparent touch icon on black, so it gets the white background of the design.
const TOUCH = { size: 180, padding: 16, background: '#fff' };

// The ICO and the touch icon cannot follow the browser's colour scheme: they keep the light colours.
const svg = (await readFile(join(PUBLIC_DIR, 'icon.svg'), 'utf8'))
  .replace('@media (prefers-color-scheme: dark)', '@media not all');

// Draws the icon on canvases in headless Chrome, so it is rasterised exactly as a browser does it.
function render(svgText, sizes, touch) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('icon.svg did not load'));
    img.onload = () => {
      const draw = (size, inset = 0, background = null) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const g = canvas.getContext('2d');
        if (background) { g.fillStyle = background; g.fillRect(0, 0, size, size); }
        g.drawImage(img, inset, inset, size - 2 * inset, size - 2 * inset);
        return canvas.toDataURL('image/png').split(',')[1];
      };
      resolve({ ico: sizes.map((s) => draw(s)), touch: draw(touch.size, touch.padding, touch.background) });
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  });
}

async function inChrome(fn, ...args) {
  const profile = await mkdtemp(join(tmpdir(), 'icons-'));
  const browser = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank']);
  try {
    const port = await new Promise((resolve, reject) => {
      browser.on('error', () => reject(new Error(`Chrome not found at ${CHROME}; set CHROME to its path.`)));
      let log = '';
      browser.stderr.on('data', (d) => {
        log += d;
        const m = log.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (m) resolve(m[1]);
      });
    });
    const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const reply = new Promise((resolve) => { ws.onmessage = (m) => resolve(JSON.parse(m.data)); });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: `(${fn})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true,
    } }));
    const { result } = await reply;
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'rendering failed');
    return result.result.value;
  } finally {
    browser.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

// An ICO file whose images are PNGs (every browser and Windows since Vista read these).
function ico(pngs, sizes) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(sizes[i] % 256, entry); // width; 0 means 256
    header.writeUInt8(sizes[i] % 256, entry + 1); // height
    header.writeUInt16LE(1, entry + 4); // colour planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}

const out = await inChrome(render, svg, ICO_SIZES, TOUCH);
const pngs = out.ico.map((b64) => Buffer.from(b64, 'base64'));
await writeFile(join(PUBLIC_DIR, 'favicon.ico'), ico(pngs, ICO_SIZES));
await writeFile(join(PUBLIC_DIR, 'apple-touch-icon.png'), Buffer.from(out.touch, 'base64'));
console.log(`Wrote favicon.ico (${ICO_SIZES.join(', ')} px) and apple-touch-icon.png (${TOUCH.size} px).`);
